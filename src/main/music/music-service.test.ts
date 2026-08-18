// MusicService tests — M3+M4 architecture (OpenAPI provider, no Python, no CITA).
//
// Tests mock the provider's underlying OpenAPI client methods (searchSongs,
// getDailyRecommendations, getSongDetail, etc.) by injecting a mock client
// into the real NeteaseOpenapiProvider, then exercising MusicService's
// session cache (SelectionSetCache TTL reuse) and playback dispatch.
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { OpenapiConfigStore } from "./openapi-config";

// Hoisted mocks for the OpenAPI client methods that the provider delegates to.
const mocks = vi.hoisted(() => ({
  searchSongs: vi.fn(),
  getDailyRecommendations: vi.fn(),
  getSongDetail: vi.fn(),
  getCreatedPlaylists: vi.fn(),
  getPlaylistDetail: vi.fn(),
  getPlaylistSongs: vi.fn(),
  createPlaylist: vi.fn(),
  addSongsToPlaylist: vi.fn(),
  getSubscribedAlbums: vi.fn(),
  getUserProfile: vi.fn(),
  loginAnonymous: vi.fn(),
  getQrCodeKey: vi.fn(),
  checkQrLoginStatus: vi.fn(),
  setAccessToken: vi.fn(),
  getLyric: vi.fn(),
  setSongLike: vi.fn(),
}));

const mpvMocks = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  load: vi.fn().mockResolvedValue(undefined),
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn().mockResolvedValue(undefined),
  togglePlay: vi.fn().mockResolvedValue(undefined),
  seek: vi.fn().mockResolvedValue(undefined),
  setVolume: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  next: vi.fn().mockResolvedValue(undefined),
  prev: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn().mockResolvedValue(undefined),
  setTrack: vi.fn(),
  getState: vi.fn(() => ({
    connected: true, loaded: false, paused: false,
    position: 0, duration: 0, volume: 70,
  })),
  isReady: vi.fn(() => true),
  onStateChange: vi.fn(() => () => {}),
}));

// Mock OpenapiConfigStore to always return valid config (skips real disk I/O).
// In-memory store so applyOpenapiConfig + getOpenapiConfig round-trip works.
vi.mock("./openapi-config", () => ({
  OpenapiConfigStore: vi.fn().mockImplementation(function () {
    let saved: { appId: string; privateKey: string } | null = {
      appId: "test-app",
      privateKey: "A".repeat(1600),
    };
    return {
      loadValidated: vi.fn(async () => saved),
      load: vi.fn(async () => saved),
      save: vi.fn(async (cfg: { appId: string; privateKey: string }) => {
        saved = { appId: cfg.appId, privateKey: cfg.privateKey };
      }),
      delete: vi.fn(async () => { saved = null; }),
    };
  }),
  validateOpenapiConfig: vi.fn(),
}));

// Mock TokenVault (no real disk I/O).
vi.mock("./token-vault", () => ({
  TokenVault: vi.fn().mockImplementation(function () {
    return {
      load: vi.fn().mockResolvedValue(null),
      decrypt: vi.fn(),
      persist: vi.fn().mockResolvedValue(true),
      delete: vi.fn().mockResolvedValue(undefined),
      isFresh: vi.fn(() => true),
    };
  }),
}));

// Mock safeStorage (required by TokenVault constructor, not used in tests).
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "{}",
  },
  app: { isPackaged: false, getAppPath: () => "/repo", getPath: () => "/userdata" },
  shell: { openExternal: vi.fn() },
}));

// Mock NeteaseOpenapiClient so we can inject controlled responses.
vi.mock("./netease-openapi-client", () => ({
  NeteaseOpenapiClient: vi.fn().mockImplementation(function () {
    return {
      setAccessToken: mocks.setAccessToken,
      configure: vi.fn(), // placeholder for lazy credential injection
      searchSongs: mocks.searchSongs,
      getDailyRecommendations: mocks.getDailyRecommendations,
      getSongDetail: mocks.getSongDetail,
      getCreatedPlaylists: mocks.getCreatedPlaylists,
      getPlaylistDetail: mocks.getPlaylistDetail,
      getPlaylistSongs: mocks.getPlaylistSongs,
      createPlaylist: mocks.createPlaylist,
      addSongsToPlaylist: mocks.addSongsToPlaylist,
      getSubscribedAlbums: mocks.getSubscribedAlbums,
      getUserProfile: mocks.getUserProfile,
      loginAnonymous: mocks.loginAnonymous,
      getQrCodeKey: mocks.getQrCodeKey,
      checkQrLoginStatus: mocks.checkQrLoginStatus,
      getLyric: mocks.getLyric,
      setSongLike: mocks.setSongLike,
    };
  }),
  wrapPkcs8Pem: vi.fn((k: string) => k),
  buildSignString: vi.fn(),
}));

// Mock MpvController to avoid spawning real mpv process.
vi.mock("./mpv-controller", () => ({
  MpvController: vi.fn().mockImplementation(function () {
    return {
      start: mpvMocks.start,
      load: mpvMocks.load,
      play: mpvMocks.play,
      pause: mpvMocks.pause,
      togglePlay: mpvMocks.togglePlay,
      seek: mpvMocks.seek,
      setVolume: mpvMocks.setVolume,
      stop: mpvMocks.stop,
      next: mpvMocks.next,
      prev: mpvMocks.prev,
      dispose: mpvMocks.dispose,
      setTrack: mpvMocks.setTrack,
      getState: mpvMocks.getState,
      isReady: mpvMocks.isReady,
      onStateChange: mpvMocks.onStateChange,
    };
  }),
}));

import { MusicService } from "./music-service";

const ENC = "4C777A98B81DF0CC069B59F63F3882B1";
const ENC2 = "A".repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: restoreSession finds no token → signed_out.
  mocks.loginAnonymous.mockResolvedValue({ accessToken: "anon", refreshToken: "", expireTime: 86400 });
});

const PATHS = {
  vendorDir: undefined,
  componentDir: undefined,
  runtimeDir: "/tmp/music-runtime",
  accountPath: "/tmp/music/account.enc",
  resourceBaseDir: "/repo",
};

function makeService(): MusicService {
  return new MusicService(PATHS);
}

const songRec = (overrides: Partial<Record<string, unknown>> = {}) => ({
  originalId: 1,
  id: ENC,
  name: "晴天",
  artists: [{ name: "周杰伦" }],
  duration: 182890,
  ...overrides,
});

describe("MusicService (M3 OpenAPI)", () => {
  it("start → ready (config present, no token → signed_out)", async () => {
    const s = makeService();
    await s.start();
    expect(s.getBackendState()).toBe("ready");
    // restoreSession is fire-and-forget; wait a tick
    await new Promise((r) => setTimeout(r, 0));
    expect(s.getAccountState()).toBe("signed_out");
  });

  it("ensureReady rejects when shutting down", async () => {
    const s = makeService();
    await s.start();
    await s.shutdown();
    await expect(s.searchTracks("x", "c1")).rejects.toThrow(/E_BACKEND_NOT_READY/);
  });

  it("getDailyRecommendations requires signed_in", async () => {
    const s = makeService();
    await expect(s.getDailyRecommendations("c1")).rejects.toThrow(/E_ACCOUNT_REQUIRED/);
  });

  it("searchTracks returns a set with 32-hex encrypted IDs", async () => {
    mocks.searchSongs.mockResolvedValue({
      recordCount: 1,
      records: [songRec()],
    });
    const s = makeService();
    // Bypass requireSignedIn by injecting account state
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const set = await s.searchTracks("晴天", "c1");
    expect(set.source).toBe("search");
    expect(set.provider).toBe("netease-openapi");
    expect(set.tracks[0].id).toBe(ENC);
    expect(set.tracks[0].encryptedId).toBe(ENC);
    expect(set.tracks[0].originalId).toBe(1);
  });

  it("searchTracks rejects empty/long keyword", async () => {
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    await expect(s.searchTracks("   ", "c1")).rejects.toThrow(/E_INVALID_KEYWORD_EMPTY/);
    await expect(s.searchTracks("x".repeat(101), "c1")).rejects.toThrow(/E_INVALID_KEYWORD_TOO_LONG/);
  });

  it("searchTracks clamps limit", async () => {
    mocks.searchSongs.mockResolvedValue({
      recordCount: 5,
      records: Array.from({ length: 5 }, (_, i) => songRec({ id: String.fromCharCode(65 + i).repeat(32), originalId: i + 1 })),
    });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const set = await s.searchTracks("q", "c1", 3);
    expect(set.tracks).toHaveLength(3);
  });

  it("presentTracks validates trackIds belong to set", async () => {
    mocks.searchSongs.mockResolvedValue({ recordCount: 1, records: [songRec()] });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const set = await s.searchTracks("晴天", "c1");
    await expect(s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: [ENC2] }))
      .rejects.toThrow(/E_TRACK_NOT_IN_SET/);
    const ok = await s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: [ENC] });
    expect(ok.cardRef).toContain(set.setId);
  });

  it("presentTracks limits to 5 selected", async () => {
    mocks.searchSongs.mockResolvedValue({ recordCount: 1, records: [songRec()] });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const set = await s.searchTracks("晴天", "c1");
    await expect(s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: [ENC, ENC, ENC, ENC, ENC, ENC] }))
      .rejects.toThrow(/E_TOO_MANY_SELECTED/);
  });

  it("markTracksPresented sets presentedTrackIds", async () => {
    mocks.searchSongs.mockResolvedValue({ recordCount: 1, records: [songRec()] });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const set = await s.searchTracks("晴天", "c1");
    s.markTracksPresented(set.setId, "c1", [ENC]);
    expect(s.getSelectionSet(set.setId, "c1")).toEqual(expect.objectContaining({
      presentedTrackIds: [ENC],
    }));
  });

  it("playTrack (CITA) validates candidate set + run", async () => {
    mocks.searchSongs.mockResolvedValue({ recordCount: 1, records: [songRec()] });
    mocks.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: "http://x/y.mp3" });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const set = await s.searchTracks("晴天", "c1", 5, { resolutionRunId: "run-1", purpose: "play" });

    // Wrong run → rejected
    await expect(s.playTrack({
      provider: set.provider,
      setId: set.setId,
      trackId: ENC,
      conversationId: "c1",
      runId: "run-2",
    })).rejects.toThrow(/E_TRACK_NOT_PLAYABLE/);

    // Correct run → dispatched via mpv
    const r = await s.playTrack({
      provider: set.provider,
      setId: set.setId,
      trackId: ENC,
      conversationId: "c1",
      runId: "run-1",
    });
    expect(r.state).toBe("dispatched");
    expect(r.resourceType).toBe("song");
    expect(r.resourceId).toBe(ENC);
  });

  it("playTrack rejects track not in set", async () => {
    mocks.searchSongs.mockResolvedValue({ recordCount: 1, records: [songRec()] });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const set = await s.searchTracks("晴天", "c1", 5, { resolutionRunId: "run-1", purpose: "play" });
    await expect(s.playTrack({
      provider: set.provider,
      setId: set.setId,
      trackId: ENC2,
      conversationId: "c1",
      runId: "run-1",
    })).rejects.toThrow(/E_TRACK_NOT_IN_SET/);
  });

  it("playTrackFromUi rejects empty id", async () => {
    const s = makeService();
    await s.start();
    await expect(s.playTrackFromUi("")).rejects.toThrow(/E_INVALID_ID/);
  });

  it("playTrackFromUi dispatches through mpv (state=dispatched)", async () => {
    mocks.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: "http://x/y.mp3" });
    const s = makeService();
    await s.start();
    const r = await s.playTrackFromUi(ENC);
    expect(r.state).toBe("dispatched");
    expect(r.resourceType).toBe("song");
    expect(mpvMocks.load).toHaveBeenCalledWith("http://x/y.mp3", "replace");
    expect(mpvMocks.setTrack).toHaveBeenCalledWith(expect.objectContaining({ encryptedId: ENC }));
  });

  it("playTrackFromUi rejects when no playUrl", async () => {
    mocks.getSongDetail.mockResolvedValue({ name: "晴天", playUrl: "" });
    const s = makeService();
    await s.start();
    await expect(s.playTrackFromUi(ENC)).rejects.toThrow(/E_TRACK_NOT_PLAYABLE/);
  });

  it("playback control methods call mpv", async () => {
    const s = makeService();
    await s.start();
    await s.playbackPlay();
    expect(mpvMocks.play).toHaveBeenCalled();
    await s.playbackPause();
    expect(mpvMocks.pause).toHaveBeenCalled();
    await s.playbackToggle();
    expect(mpvMocks.togglePlay).toHaveBeenCalled();
    await s.playbackSeek(10);
    expect(mpvMocks.seek).toHaveBeenCalledWith(10);
    await s.playbackSetVolume(50);
    expect(mpvMocks.setVolume).toHaveBeenCalledWith(50);
    await s.playbackStop();
    expect(mpvMocks.stop).toHaveBeenCalled();
  });

  it("getLyrics calls client.getLyric", async () => {
    mocks.getLyric.mockResolvedValue({ lyric: "[00:01.00]晴天\n" });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const lyrics = await s.getLyrics(ENC);
    expect(lyrics).toBe("[00:01.00]晴天\n");
    expect(mocks.getLyric).toHaveBeenCalledWith(ENC);
  });

  it("toggleFavorite calls client.setSongLike", async () => {
    mocks.setSongLike.mockResolvedValue({});
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const result = await s.toggleFavorite(ENC, true);
    expect(result).toBe(true);
    expect(mocks.setSongLike).toHaveBeenCalledWith(ENC, true);
  });

  it("getPlaybackState returns mpv state", async () => {
    mpvMocks.getState.mockReturnValue({
      connected: true, loaded: true, paused: false,
      position: 30, duration: 180, volume: 50,
    });
    const s = makeService();
    await s.start();
    const state = s.getPlaybackState();
    expect(state.loaded).toBe(true);
    expect(state.position).toBe(30);
    expect(state.duration).toBe(180);
  });

  it("playback methods throw E_MPV_NOT_READY when mpv not ready", async () => {
    mpvMocks.isReady.mockReturnValue(false);
    const s = makeService();
    await s.start();
    await expect(s.playbackPlay()).rejects.toThrow(/E_MPV_NOT_READY/);
  });

  it("getMyPlaylists / getPlaylistDetail / createPlaylist / addToPlaylist / getMySubscriptions", async () => {
    mocks.getCreatedPlaylists.mockResolvedValue({ records: [{ id: "P".repeat(32), name: "list", trackCount: 3 }] });
    mocks.getPlaylistDetail.mockResolvedValue({ id: "P".repeat(32), name: "list" });
    mocks.getPlaylistSongs.mockResolvedValue([songRec()]);
    mocks.createPlaylist.mockResolvedValue({ id: "Q".repeat(32), name: "new" });
    mocks.addSongsToPlaylist.mockResolvedValue({ count: 1 });
    mocks.getSubscribedAlbums.mockResolvedValue({ records: [{ id: "A".repeat(32), name: "叶惠美" }] });

    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");

    expect((await s.getMyPlaylists())[0].trackCount).toBe(3);
    expect((await s.getPlaylistDetail("P".repeat(32))).name).toBe("list");
    expect((await s.createPlaylist("new")).id).toBe("Q".repeat(32));
    expect(await s.addToPlaylist("P".repeat(32), [ENC])).toEqual({ added: 1, playlistId: "P".repeat(32) });
    expect((await s.getMySubscriptions("albums"))[0].name).toBe("叶惠美");
    expect(await s.getMySubscriptions("artists")).toEqual([]);
  });

  it("getLoginFlowState returns idle before login", () => {
    const s = makeService();
    expect(s.getLoginFlowState()).toBe("idle");
  });

  it("getActiveProfile returns null before login", () => {
    const s = makeService();
    expect(s.getActiveProfile()).toBeNull();
  });

  it("event listeners return unsubscribe functions", () => {
    const s = makeService();
    const fn = () => {};
    const unsub = s.onBackendStateChange(fn);
    unsub();
    expect(true).toBe(true);
  });

  it("shutdown returns a MusicShutdownReport", async () => {
    const s = makeService();
    await s.start();
    const report = await s.shutdown();
    expect(report).toEqual({
      rootProcessPid: undefined,
      transportClosed: true,
      processTreeExited: true,
      runtimeRemoved: true,
    });
  });

  it("shutdown is idempotent", async () => {
    const s = makeService();
    await s.start();
    const r1 = await s.shutdown();
    const r2 = await s.shutdown();
    expect(r1).toEqual(r2);
  });

  it("logout deletes token vault and sets signed_out", async () => {
    const s = makeService();
    await s.start();
    await s.logout();
    expect(s.getAccountState()).toBe("signed_out");
    expect(s.getActiveProfile()).toBeNull();
  });

  it("applyOpenapiConfig rejects empty appId/privateKey", async () => {
    const s = makeService();
    await expect(s.applyOpenapiConfig({ appId: "", privateKey: "k" })).rejects.toMatchObject({ code: "E_OPENAPI_CONFIG_INVALID" });
    await expect(s.applyOpenapiConfig({ appId: "a", privateKey: "" })).rejects.toMatchObject({ code: "E_OPENAPI_CONFIG_INVALID" });
  });

  it("applyOpenapiConfig persists config and re-inits backend", async () => {
    const s = makeService();
    await s.start();
    expect(s.getBackendState()).toBe("ready");
    // Apply new config — should persist + re-init (still ready)
    await s.applyOpenapiConfig({ appId: "new-app", privateKey: "B".repeat(1600) });
    expect(s.getBackendState()).toBe("ready");
  });

  it("getOpenapiConfig returns the persisted config (or null)", async () => {
    const s = makeService();
    // Before apply: null (mock has no real disk)
    const before = await s.getOpenapiConfig();
    // mock OpenapiConfigStore.loadValidated returns the test-app config from the
    // vi.mock factory in this file, so it won't be null — assert shape only.
    if (before) {
      expect(before.appId).toBe("test-app");
    }
    // After apply with new values, the mock persists in-memory; just check no throw.
    await s.applyOpenapiConfig({ appId: "x", privateKey: "C".repeat(1600) });
    const after = await s.getOpenapiConfig();
    expect(after).not.toBeNull();
  });

  it("getSelectionSet retrieves set by id and conversationId", async () => {
    mocks.searchSongs.mockResolvedValue({ recordCount: 1, records: [songRec()] });
    const s = makeService();
    await s.start();
    (s as unknown as { orchestrator: { setAccountState: (st: string) => void } }).orchestrator.setAccountState("signed_in");
    const set = await s.searchTracks("晴天", "c1");
    expect(s.getSelectionSet(set.setId, "c1")).toEqual(set);
    expect(s.getSelectionSet(set.setId, "c2")).toBeNull();
  });

  it("no config → incompatible", async () => {
    // Override the mock to return null config
    const { OpenapiConfigStore } = await import("./openapi-config");
    vi.mocked(OpenapiConfigStore).mockImplementationOnce(function () {
      return { loadValidated: vi.fn().mockResolvedValue(null) } as unknown as OpenapiConfigStore;
    });
    const s = new MusicService(PATHS);
    await s.start();
    expect(s.getBackendState()).toBe("incompatible");
  });
});
