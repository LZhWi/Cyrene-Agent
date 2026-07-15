import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MusicMcpClient } from "./music-mcp-client";
import { ProtocolDetector } from "./protocol-detector";
import { PlaybackDispatcher } from "./playback-dispatcher";
import { CookieVault } from "./cookie-vault";
import { LoginOrchestrator } from "./login-orchestrator";
import { SelectionSetCache } from "./selection-set-cache";
import { normalizeDailyRecommendations, normalizeSearchResults } from "./result-normalizer";
import { MusicInputError } from "./types";
import type { MusicPaths } from "./paths";
import type {
  MusicSelectionSet,
  PlaybackDispatchResult,
  MusicBackendState,
  MusicAccountState,
  MusicPlayerState,
} from "./types";

const SET_TTL_MS = 30 * 60_000;

export interface PresentResult {
  cardRef: string;
}

export class MusicService {
  private backendState: MusicBackendState = "ready";
  private playerState: MusicPlayerState = "unknown";

  private readonly client: MusicMcpClient;
  private readonly detector: ProtocolDetector;
  private readonly dispatcher: PlaybackDispatcher;
  private readonly vault: CookieVault;
  private readonly orchestrator: LoginOrchestrator;
  private readonly cache: SelectionSetCache;
  private readonly paths: MusicPaths;

  constructor(paths: MusicPaths) {
    this.paths = paths;
    this.client = new MusicMcpClient(paths.vendorDir, paths.runtimeDir);
    this.detector = new ProtocolDetector();
    this.dispatcher = new PlaybackDispatcher(this.detector);
    this.vault = new CookieVault(path.dirname(paths.accountPath));
    this.orchestrator = new LoginOrchestrator({
      client: this.client,
      runtimeDir: paths.runtimeDir,
      vault: this.vault,
    });
    this.cache = new SelectionSetCache();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    this.backendState = "starting";
    try {
      await this.client.connect();
      const contract = await this.client.verifyContractOnConnect();
      if (!contract.ok) {
        this.backendState = "incompatible";
        return;
      }

      const protocolOk = await this.detector.isRegistered();
      this.playerState = protocolOk ? "available" : "unavailable";

      // Restore saved account session into runtime cookies
      try {
        const blob = await this.vault.load();
        if (blob) {
          const payload = await this.vault.decrypt(blob);
          const cookiesPath = path.join(this.paths.runtimeDir, "cookies.json");
          await fs.mkdir(this.paths.runtimeDir, { recursive: true });
          await fs.writeFile(cookiesPath, JSON.stringify(payload.cookies), "utf8");
          this.orchestrator.setAccountState("signed_in");
        } else {
          this.orchestrator.setAccountState("signed_out");
        }
      } catch {
        this.orchestrator.setAccountState("signed_out");
      }

      this.backendState = "ready";
    } catch (err) {
      this.backendState = "failed";
      throw err;
    }
  }

  async shutdown(): Promise<void> {
    try { await this.orchestrator.shutdown(); } catch { /* ignore */ }
    try { await this.client.close(); } catch { /* ignore */ }
    try { await fs.rm(this.paths.runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.backendState = "stopped";
  }

  // ── State accessors ────────────────────────────────────────

  getBackendState(): MusicBackendState {
    return this.backendState;
  }

  getAccountState(): MusicAccountState {
    return this.orchestrator.getAccountState();
  }

  getPlayerState(): MusicPlayerState {
    return this.playerState;
  }

  // ── Login ──────────────────────────────────────────────────

  async beginLogin() {
    this.requireReady();
    return this.orchestrator.beginLogin();
  }

  async cancelLogin() {
    return this.orchestrator.cancelLogin();
  }

  // ── Data ───────────────────────────────────────────────────

  async getDailyRecommendations(conversationId: string): Promise<MusicSelectionSet> {
    this.requireReady();
    this.requireSignedIn();
    const raw = await this.client.callDataTool("cloud_music_get_daily_recommend", {});
    const tracks = normalizeDailyRecommendations(this.unwrapContent(raw));
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      source: "daily_recommendation",
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
      tracks,
    };
    this.cache.add(set);
    return set;
  }

  async searchTracks(keyword: string, conversationId: string, limit?: number): Promise<MusicSelectionSet> {
    this.requireReady();
    if (keyword.length > 100) {
      throw new MusicInputError("E_INVALID_KEYWORD_TOO_LONG");
    }
    const clampedLimit = Math.max(1, Math.min(limit ?? 20, 20));
    const raw = await this.client.callDataTool("cloud_music_search", { keyword, limit: clampedLimit });
    const tracks = normalizeSearchResults(this.unwrapContent(raw));
    const setId = crypto.randomUUID();
    const set: MusicSelectionSet = {
      setId,
      source: "search",
      query: keyword,
      createdAt: Date.now(),
      expiresAt: Date.now() + SET_TTL_MS,
      conversationId,
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
    if (!set) {
      throw new MusicInputError("E_SET_NOT_FOUND");
    }
    if (trackIds.length === 0 || trackIds.length > 5) {
      throw new MusicInputError("E_TOO_MANY_SELECTED");
    }
    if (reasons && reasons.length !== trackIds.length) {
      throw new MusicInputError("E_REASONS_MISMATCH");
    }
    const setTrackIds = new Set(set.tracks.map((t) => t.id));
    for (const tid of trackIds) {
      if (!setTrackIds.has(tid)) {
        throw new MusicInputError("E_TRACK_NOT_IN_SET");
      }
    }
    this.cache.touch(setId);
    const cardRef = `cyrene:music:${setId}:${trackIds.join(":")}`;
    return { cardRef };
  }

  // ── Playback ───────────────────────────────────────────────

  async playTrack(trackId: string): Promise<PlaybackDispatchResult> {
    this.requireReady();
    if (!/^\d+$/.test(trackId)) {
      throw new MusicInputError("E_INVALID_ID");
    }
    return this.dispatcher.dispatch("song", trackId);
  }

  async playPlaylist(playlistId: string): Promise<PlaybackDispatchResult> {
    this.requireReady();
    if (!/^\d+$/.test(playlistId)) {
      throw new MusicInputError("E_INVALID_ID");
    }
    return this.dispatcher.dispatch("playlist", playlistId);
  }

  // ── Helpers ────────────────────────────────────────────────

  private requireReady(): void {
    if (this.backendState !== "ready") {
      throw new MusicInputError("E_BACKEND_NOT_READY");
    }
  }

  private requireSignedIn(): void {
    if (this.orchestrator.getAccountState() !== "signed_in") {
      throw new MusicInputError("E_ACCOUNT_REQUIRED");
    }
  }

  /**
   * Unwrap an MCP CallToolResult content array into the first text payload.
   * If the result does not look like an MCP envelope it is returned as-is.
   */
  private unwrapContent(result: unknown): unknown {
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (Array.isArray(r.content)) {
        const first = (r.content as Array<Record<string, unknown>>)[0];
        if (first && first.type === "text" && typeof first.text === "string") {
          try {
            return JSON.parse(first.text);
          } catch {
            return result;
          }
        }
      }
    }
    return result;
  }
}
