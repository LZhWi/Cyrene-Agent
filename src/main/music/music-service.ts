// MusicService — M3+M4 rewrite: OpenAPI provider, no Python lifecycle, no CITA.
//
// Replaces MusicMcpClient/ProtocolDetector/CookieVault/LoginOrchestrator with
// NeteaseOpenapiClient/TokenVault/OpenapiLoginOrchestrator.  SelectionSetCache
// is retained as a TTL session cache for daily/search result reuse (no longer
// used for CITA candidate gating — that was removed in M4).
import * as crypto from "node:crypto";
import * as path from "node:path";
import { NeteaseOpenapiClient } from "./netease-openapi-client";
import { TokenVault } from "./token-vault";
import { OpenapiLoginOrchestrator } from "./openapi-login-orchestrator";
import { NeteaseOpenapiProvider } from "./netease-openapi-provider";
import { OpenapiConfigStore } from "./openapi-config";
import { SelectionSetCache } from "./selection-set-cache";
import { MpvController } from "./mpv-controller";
import type { PlaybackDispatcher } from "./netease-openapi-provider";
import { MusicInputError } from "./types";
import { assertEncryptedId } from "./openapi-result-normalizer";
import type { MusicPaths } from "./paths";
import type {
  MusicSelectionSet,
  PlaybackDispatchResult,
  MusicBackendState,
  MusicAccountState,
  MusicPlayerState,
  LoginFlowState,
  MusicProfile,
  MusicShutdownReport,
  CandidatePlaybackRequest,
  MusicPlaylist,
  MusicPlaylistDetail,
  MusicSubscription,
} from "./types";
import type { MusicStatusSnapshot } from "../../shared/music-view-state";
import type { PlaybackState } from "../../shared/music-types";

const SET_TTL_MS = 30 * 60_000;

export interface PresentResult {
  cardRef: string;
}

type StateListener<T> = (state: T) => void;

export class MusicService {
  private backendState: MusicBackendState = "stopped";
  private playerState: MusicPlayerState = "unknown";
  private activeProfile: MusicProfile | null = null;
  private shuttingDown = false;
  private startPromise: Promise<void> | null = null;

  private readonly configStore: OpenapiConfigStore;
  private readonly client: NeteaseOpenapiClient;
  private readonly tokenVault: TokenVault;
  private readonly orchestrator: OpenapiLoginOrchestrator;
  private provider: NeteaseOpenapiProvider;
  private readonly cache: SelectionSetCache;
  private readonly paths: MusicPaths;
  private mpv: MpvController | null = null;
  private currentPlayback: PlaybackState["track"] | null = null;

  private backendListeners = new Set<StateListener<MusicBackendState>>();
  private accountListeners = new Set<StateListener<MusicAccountState>>();
  private playerListeners = new Set<StateListener<MusicPlayerState>>();
  private flowListeners = new Set<StateListener<LoginFlowState>>();
  private stateListeners = new Set<StateListener<MusicStatusSnapshot>>();
  // mpv 未启动时缓存的 playback 监听器，mpv.start() 后批量补注册
  private pendingPlaybackListeners = new Set<(state: PlaybackState) => void>();

  constructor(paths: MusicPaths) {
    this.paths = paths;
    const configDir = path.dirname(paths.accountPath);
    this.configStore = new OpenapiConfigStore(configDir);
    this.tokenVault = new TokenVault(configDir);
    // Client created lazily with config on start(); placeholder until then.
    this.client = new NeteaseOpenapiClient({ appId: "", privateKey: "" });
    this.orchestrator = new OpenapiLoginOrchestrator({
      client: this.client,
      vault: this.tokenVault,
    });
    this.provider = new NeteaseOpenapiProvider(this.client);
    this.cache = new SelectionSetCache();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.backendState === "ready" || this.backendState === "degraded") return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.initOpenapi();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /**
   * M3: no Python process to start. "ready" = OpenAPI config present.
   * If no config yet → "incompatible" (renderer prompts user to configure).
   * If config present → inject into client + restore token session.
   */
  private async initOpenapi(): Promise<void> {
    const config = await this.configStore.loadValidated();
    if (!config) {
      this.backendState = "incompatible";
      this.emitBackendChange("incompatible");
      return;
    }
    // Inject real credentials into the placeholder client (constructed with
    // empty appId/privateKey — see MusicService constructor).
    this.client.configure({ appId: config.appId, privateKey: config.privateKey });
    this.backendState = "ready";
    this.emitBackendChange("ready");

    // Restore saved token session FIRST (doesn't depend on mpv). Token 恢复
    // 不阻塞播放器初始化，避免 mpv 启动慢时 UI 一直看到 account: unknown。
    await this.orchestrator.restoreSession().then((ok) => {
      this.emitAccountChange(this.orchestrator.getAccountState());
    });

    // Start mpv and wire its dispatcher into the provider.
    this.mpv = new MpvController();
    try {
      await this.mpv.start();
      // 补注册 mpv 启动前缓存的 playback 监听器（ipc-handlers 在 app 启动时注册）
      for (const l of this.pendingPlaybackListeners) {
        this.mpv.onStateChange(l);
      }
      this.pendingPlaybackListeners.clear();
      const dispatcher: PlaybackDispatcher = async (resource) => {
        if (!this.mpv) {
          console.log("[music-debug] dispatcher: mpv is null");
          return { state: "client_unavailable", resourceType: resource.kind, resourceId: "", errorCode: "E_MPV_NOT_STARTED" };
        }
        const dispatchTrackId = resource.kind === "song" ? resource.track.id : resource.tracks[0]?.id ?? "";
        console.log("[music-debug] dispatcher before load:", {
          kind: resource.kind,
          hasUrl: !!resource.playUrl,
          urlLen: resource.playUrl.length,
          trackId: dispatchTrackId,
        });
        await this.mpv.load(resource.playUrl, "replace");
        console.log("[music-debug] dispatcher load done, about to setTrack:", { trackId: dispatchTrackId });
        if (resource.kind === "song") {
          this.currentPlayback = {
            encryptedId: resource.track.id,
            name: resource.track.name,
            artists: resource.track.artists,
            coverUrl: resource.track.coverUrl,
          };
          this.mpv.setTrack(this.currentPlayback);
          console.log("[music-debug] dispatcher setTrack done (song):", { encId: this.currentPlayback.encryptedId, name: this.currentPlayback.name });
        } else {
          this.currentPlayback = {
            encryptedId: resource.tracks[0]?.id ?? "",
            name: resource.tracks[0]?.name ?? "playlist",
            artists: resource.tracks[0]?.artists ?? [],
            coverUrl: resource.tracks[0]?.coverUrl,
          };
          this.mpv.setTrack(this.currentPlayback);
          console.log("[music-debug] dispatcher setTrack done (playlist):", { encId: this.currentPlayback.encryptedId, name: this.currentPlayback.name });
        }
        this.playerState = "available";
        this.emitPlayerChange("available");
        return { state: "dispatched", resourceType: resource.kind, resourceId: resource.kind === "song" ? resource.track.id : "" };
      };
      this.provider = new NeteaseOpenapiProvider(this.client, dispatcher);
      this.mpv.onStateChange(() => this.emitStateChange());
      // mpv 启动成功后显式广播 player: available
      this.emitPlayerChange("available");
    } catch (err) {
      // mpv not found → degraded but still functional for non-playback operations.
      console.error("[music] mpv 启动失败，播放器降级为不可用：", err instanceof Error ? err.message : err);
      this.playerState = "unavailable";
      this.provider = new NeteaseOpenapiProvider(this.client);
      this.emitPlayerChange("unavailable");
    }
  }

  async shutdown(): Promise<MusicShutdownReport> {
    if (this.shuttingDown) {
      return {
        rootProcessPid: undefined,
        transportClosed: true,
        processTreeExited: true,
        runtimeRemoved: true,
      };
    }
    this.shuttingDown = true;
    try {
      await this.orchestrator.shutdown();
    } catch { /* ignore */ }
    if (this.mpv) {
      try { await this.mpv.dispose(); } catch { /* ignore */ }
      this.mpv = null;
    }
    this.backendState = "stopped";
    this.emitBackendChange("stopped");
    return {
      rootProcessPid: undefined,
      transportClosed: true,
      processTreeExited: true,
      runtimeRemoved: true,
    };
  }

  // ── State accessors ────────────────────────────────────────

  getBackendState(): MusicBackendState { return this.backendState; }
  getAccountState(): MusicAccountState { return this.orchestrator.getAccountState(); }
  getPlayerState(): MusicPlayerState { return this.playerState; }
  getLoginFlowState(): LoginFlowState { return this.orchestrator.getFlowState(); }
  /** Lyrics cache directory under userData — used by IPC handler for MUSIC_GET_LYRICS. */
  getLyricsCacheDir(): string { return path.join(this.paths.runtimeDir, "lyrics-cache"); }
  getActiveProfile(): MusicProfile | null { return this.activeProfile; }

  getSelectionSet(setId: string, conversationId: string): MusicSelectionSet | null {
    return this.cache.get(setId, conversationId);
  }

  getLatestSelectionSet(
    conversationId: string,
    source?: MusicSelectionSet["source"],
  ): MusicSelectionSet | null {
    return this.cache.latest(conversationId, source);
  }

  // ── Login poll passthrough ─────────────────────────────────

  async pollOnce(): Promise<unknown> {
    const result = await this.orchestrator.pollOnce();
    this.emitStateChange();
    return result;
  }

  // ── Event listeners ────────────────────────────────────────

  onBackendStateChange(listener: StateListener<MusicBackendState>): () => void {
    this.backendListeners.add(listener);
    return () => this.backendListeners.delete(listener);
  }
  onAccountStateChange(listener: StateListener<MusicAccountState>): () => void {
    this.accountListeners.add(listener);
    return () => this.accountListeners.delete(listener);
  }
  onPlayerStateChange(listener: StateListener<MusicPlayerState>): () => void {
    this.playerListeners.add(listener);
    return () => this.playerListeners.delete(listener);
  }
  onLoginFlowStateChange(listener: StateListener<LoginFlowState>): () => void {
    this.flowListeners.add(listener);
    return () => this.flowListeners.delete(listener);
  }
  onStateChange(listener: StateListener<MusicStatusSnapshot>): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }
  onPlaybackStateChange(listener: (state: PlaybackState) => void): () => void {
    if (this.mpv) {
      return this.mpv.onStateChange(listener);
    }
    // mpv 尚未启动：缓存 listener，start() 完成后补注册
    this.pendingPlaybackListeners.add(listener);
    return () => {
      this.pendingPlaybackListeners.delete(listener);
    };
  }

  getSnapshot(): MusicStatusSnapshot {
    return {
      backend: this.backendState,
      account: this.getAccountState(),
      player: this.playerState,
      flow: this.getLoginFlowState(),
      profile: this.activeProfile,
    };
  }

  private emitStateChange(): void {
    const snapshot = this.getSnapshot();
    for (const l of this.stateListeners) l(snapshot);
  }

  // ── Login ──────────────────────────────────────────────────

  async beginLogin() {
    await this.ensureReady();
    return this.orchestrator.beginLogin();
  }

  async cancelLogin() {
    await this.orchestrator.cancelLogin();
    this.emitStateChange();
  }

  async logout(): Promise<void> {
    await this.orchestrator.cancelLogin();
    await this.tokenVault.delete();
    this.client.setAccessToken(null);
    this.activeProfile = null;
    this.orchestrator.setAccountState("signed_out");
    this.emitAccountChange("signed_out");
  }

  /**
   * Write OpenAPI credentials (appId + privateKey) to disk and re-init the
   * backend with the new config.  Called from the settings panel IPC handler
   * when the user fills in the OpenAPI config form.
   *
   * If the backend is already ready, the existing client is re-configured
   * in place; otherwise start() is triggered to pick up the new config.
   */
  async applyOpenapiConfig(config: { appId: string; privateKey: string }): Promise<void> {
    // Validate before persisting — OpenapiConfigStore.save() also validates,
    // but we want a clearer error here for the IPC layer.
    if (!config.appId || typeof config.appId !== "string") {
      throw new MusicInputError("E_OPENAPI_CONFIG_INVALID", "appId required");
    }
    if (!config.privateKey || typeof config.privateKey !== "string") {
      throw new MusicInputError("E_OPENAPI_CONFIG_INVALID", "privateKey required");
    }
    await this.configStore.save(config);
    // Reset startPromise so start() can run again after a failed/incompatible init.
    this.startPromise = null;
    this.backendState = "stopped";
    await this.start();
  }

  /** Read the current persisted OpenAPI config (or null if not configured). */
  async getOpenapiConfig(): Promise<{ appId: string; privateKey: string } | null> {
    return this.configStore.loadValidated();
  }

  // ── Data ───────────────────────────────────────────────────

  async getDailyRecommendations(
    conversationId: string,
    options: { resolutionRunId?: string } = {},
  ): Promise<MusicSelectionSet> {
    await this.ensureReady();
    this.requireSignedIn();
    const tracks = await this.provider.getDailyRecommendations();
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      provider: this.provider.id,
      source: "daily_recommendation",
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      resolutionRunId: options.resolutionRunId,
      resolutionPurpose: "discover",
      tracks,
    };
    this.cache.add(set);
    return set;
  }

  async searchTracks(
    keyword: string,
    conversationId: string,
    limit?: number,
    options: { resolutionRunId?: string; purpose?: "discover" | "play" } = {},
  ): Promise<MusicSelectionSet> {
    await this.ensureReady();
    const trimmed = (typeof keyword === "string" ? keyword : "").trim();
    if (trimmed.length === 0) throw new MusicInputError("E_INVALID_KEYWORD_EMPTY");
    if (trimmed.length > 100) throw new MusicInputError("E_INVALID_KEYWORD_TOO_LONG");
    const clampedLimit = Math.max(1, Math.min(limit ?? 20, 20));
    const tracks = (await this.provider.searchTracks(trimmed)).slice(0, clampedLimit);
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      provider: this.provider.id,
      source: "search",
      query: trimmed,
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      resolutionRunId: options.resolutionRunId,
      resolutionPurpose: options.purpose ?? "discover",
      tracks,
    };
    this.cache.add(set);
    return set;
  }

  async presentTracks(params: {
    setId: string;
    conversationId: string;
    trackIds: string[];
    reasons?: string[];
  }): Promise<PresentResult> {
    const { setId, conversationId, trackIds, reasons } = params;
    const set = this.cache.get(setId, conversationId);
    if (!set) throw new MusicInputError("E_SET_NOT_FOUND");
    if (trackIds.length === 0 || trackIds.length > 5) throw new MusicInputError("E_TOO_MANY_SELECTED");
    if (reasons) {
      if (reasons.length !== trackIds.length) throw new MusicInputError("E_REASONS_MISMATCH");
      for (const r of reasons) {
        if (r.length > 50) throw new MusicInputError("E_REASON_TOO_LONG");
      }
      if (reasons.join("").length > 500) throw new MusicInputError("E_REASONS_TOTAL_TOO_LONG");
    }
    const setTrackIds = new Set(set.tracks.map((t) => t.id));
    for (const tid of trackIds) {
      if (!setTrackIds.has(tid)) throw new MusicInputError("E_TRACK_NOT_IN_SET");
    }
    const cardRef = `cyrene:music:${setId}:${trackIds.join(":")}`;
    return { cardRef };
  }

  markTracksPresented(setId: string, conversationId: string, trackIds: string[]): void {
    const set = this.cache.get(setId, conversationId);
    if (!set) throw new MusicInputError("E_SET_NOT_FOUND");
    const available = new Set(set.tracks.map((track) => track.id));
    if (trackIds.length === 0 || trackIds.some((trackId) => !available.has(trackId))) {
      throw new MusicInputError("E_TRACK_NOT_IN_SET");
    }
    this.cache.markPresented(setId, conversationId, trackIds);
  }

  async getMyPlaylists(): Promise<MusicPlaylist[]> {
    await this.ensureReady();
    this.requireSignedIn();
    return this.provider.getMyPlaylists();
  }

  async getPlaylistDetail(playlistId: string): Promise<MusicPlaylistDetail> {
    await this.ensureReady();
    this.requireSignedIn();
    assertEncryptedId(playlistId);
    return this.provider.getPlaylistDetail(playlistId);
  }

  async createPlaylist(
    name: string,
    options: { privacy?: boolean } = {},
  ): Promise<MusicPlaylist> {
    await this.ensureReady();
    this.requireSignedIn();
    const trimmed = (typeof name === "string" ? name : "").trim();
    if (trimmed.length === 0) throw new MusicInputError("E_INVALID_PLAYLIST_NAME_EMPTY");
    if (trimmed.length > 100) throw new MusicInputError("E_INVALID_PLAYLIST_NAME_TOO_LONG");
    return this.provider.createPlaylist(trimmed, options.privacy);
  }

  async addToPlaylist(
    playlistId: string,
    trackIds: string[],
  ): Promise<{ added: number; playlistId: string }> {
    await this.ensureReady();
    this.requireSignedIn();
    if (!playlistId) throw new MusicInputError("E_INVALID_ID_FORMAT");
    if (!Array.isArray(trackIds) || trackIds.length === 0) {
      throw new MusicInputError("E_TRACK_IDS_EMPTY");
    }
    return this.provider.addToPlaylist(playlistId, trackIds);
  }

  async getMySubscriptions(
    category: "artists" | "albums",
  ): Promise<MusicSubscription[]> {
    await this.ensureReady();
    this.requireSignedIn();
    if (category !== "artists" && category !== "albums") {
      throw new MusicInputError("E_INVALID_SUBSCRIPTION_CATEGORY");
    }
    return this.provider.getMySubscriptions(category);
  }

  // ── Playback control (mpv) ─────────────────────────────────

  getPlaybackState(): PlaybackState {
    if (!this.mpv) {
      return { connected: false, loaded: false, paused: false, position: 0, duration: 0, volume: 70 };
    }
    return this.mpv.getState();
  }

  async playbackPlay(): Promise<void> {
    this.requireMpv();
    await this.mpv!.play();
  }

  async playbackPause(): Promise<void> {
    this.requireMpv();
    await this.mpv!.pause();
  }

  async playbackToggle(): Promise<void> {
    this.requireMpv();
    await this.mpv!.togglePlay();
  }

  async playbackSeek(seconds: number): Promise<void> {
    this.requireMpv();
    await this.mpv!.seek(seconds);
  }

  async playbackSetVolume(vol: number): Promise<void> {
    this.requireMpv();
    await this.mpv!.setVolume(vol);
  }

  async playbackStop(): Promise<void> {
    this.requireMpv();
    await this.mpv!.stop();
    this.currentPlayback = null;
    this.playerState = "unknown";
    this.emitPlayerChange("unknown");
  }

  async playbackNext(): Promise<void> {
    this.requireMpv();
    await this.mpv!.next();
  }

  async playbackPrev(): Promise<void> {
    this.requireMpv();
    await this.mpv!.prev();
  }

  private requireMpv(): void {
    if (!this.mpv || !this.mpv.isReady()) {
      throw new MusicInputError("E_MPV_NOT_READY");
    }
  }

  // ── UI 直连数据（lyrics / favorite，不经 AI 工具层） ────────

  async getLyrics(encryptedId: string): Promise<string> {
    await this.ensureReady();
    this.requireSignedIn();
    const lyric = await this.client.getLyric(encryptedId);
    return lyric.lyric ?? "";
  }

  async toggleFavorite(encryptedId: string, favorite: boolean): Promise<boolean> {
    await this.ensureReady();
    this.requireSignedIn();
    await this.client.setSongLike(encryptedId, favorite);
    return favorite;
  }

  // ── Playback dispatch ──────────────────────────────────────

  async playTrack(input: CandidatePlaybackRequest): Promise<PlaybackDispatchResult> {
    const trackId = input.trackId;
    if (!trackId) throw new MusicInputError("E_INVALID_ID_FORMAT");
    const set = this.cache.get(input.setId, input.conversationId);
    if (!set) throw new MusicInputError("E_SET_NOT_FOUND");
    if (set.provider !== input.provider) throw new MusicInputError("E_PROVIDER_MISMATCH");
    if (!set.tracks.some((track) => track.id === trackId)) {
      throw new MusicInputError("E_TRACK_NOT_IN_SET");
    }
    const wasPresented = set.presentedTrackIds?.includes(trackId) === true;
    const resolvedForThisRun = set.resolutionPurpose === "play"
      && Boolean(input.runId)
      && set.resolutionRunId === input.runId;
    if (!wasPresented && !resolvedForThisRun) {
      throw new MusicInputError("E_TRACK_NOT_PLAYABLE");
    }
    await this.ensureReady();
    return this.provider.playTrack(trackId);
  }

  /** Trusted renderer path: IDs originate from MusicService search results. */
  async playTrackFromUi(trackId: string): Promise<PlaybackDispatchResult> {
    if (!trackId) throw new MusicInputError("E_INVALID_ID_FORMAT");
    await this.ensureReady();
    return this.provider.playTrack(trackId);
  }

  async playPlaylist(playlistId: string): Promise<PlaybackDispatchResult> {
    if (!playlistId) throw new MusicInputError("E_INVALID_ID_FORMAT");
    await this.ensureReady();
    return this.provider.playPlaylist(playlistId);
  }

  // ── Helpers ────────────────────────────────────────────────

  private async ensureReady(): Promise<void> {
    if (this.shuttingDown) throw new MusicInputError("E_BACKEND_NOT_READY");
    await this.start();
    this.requireReady();
  }

  private requireReady(): void {
    if (this.backendState !== "ready" && this.backendState !== "degraded") {
      throw new MusicInputError("E_BACKEND_NOT_READY");
    }
  }

  private requireSignedIn(): void {
    if (this.orchestrator.getAccountState() !== "signed_in") {
      throw new MusicInputError("E_ACCOUNT_REQUIRED");
    }
  }

  private emitBackendChange(s: MusicBackendState): void {
    for (const l of this.backendListeners) l(s);
    this.emitStateChange();
  }
  private emitAccountChange(s: MusicAccountState): void {
    for (const l of this.accountListeners) l(s);
    this.emitStateChange();
  }
  private emitPlayerChange(s: MusicPlayerState): void {
    for (const l of this.playerListeners) l(s);
    this.emitStateChange();
  }
  private emitFlowChange(s: LoginFlowState): void {
    for (const l of this.flowListeners) l(s);
    this.emitStateChange();
  }
}
