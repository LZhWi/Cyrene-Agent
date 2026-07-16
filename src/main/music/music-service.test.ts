import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const { beginTool, checkTool, cancelTool, searchTool, dailyTool, isRegistered, openExternal } = vi.hoisted(() => ({
  beginTool: vi.fn(),
  checkTool: vi.fn(),
  cancelTool: vi.fn(),
  searchTool: vi.fn(),
  dailyTool: vi.fn(),
  isRegistered: vi.fn(),
  openExternal: vi.fn(),
}));

// Track each constructed client so logout tests can inspect the close() mock
// on the exact instance held by a given MusicService.
const clientInstances: Array<{ close: ReturnType<typeof vi.fn> }> = [];

vi.mock("./music-mcp-client", () => ({
  MusicMcpClient: vi.fn().mockImplementation(function () {
    const close = vi.fn();
    clientInstances.push({ close });
    return {
      connect: vi.fn(),
      verifyContractOnConnect: vi.fn().mockResolvedValue({ ok: true, missing: [], schemaMismatch: [] }),
      close,
      getRootPid: vi.fn().mockReturnValue(undefined),
      callDataTool: (name: string, args: unknown) => name === "cloud_music_search" ? searchTool(args) : dailyTool(args),
      callAuthTool: (name: string, args: unknown) => name === "cyrene_music_login_begin" ? beginTool(args) : name === "cyrene_music_login_check" ? checkTool(args) : cancelTool(args),
    };
  }),
}));

vi.mock("./protocol-detector", () => ({
  ProtocolDetector: vi.fn().mockImplementation(function () { return { isRegistered, invalidate: vi.fn() }; }),
}));

vi.mock("electron", () => ({
  shell: { openExternal },
  app: { isPackaged: false, getAppPath: () => "/repo", getPath: () => "/userdata" },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "{}",
  },
}));

import { MusicService } from "./music-service";

beforeEach(() => {
  beginTool.mockReset(); checkTool.mockReset(); cancelTool.mockReset();
  searchTool.mockReset(); dailyTool.mockReset();
  isRegistered.mockReset(); openExternal.mockReset();
  clientInstances.length = 0;
});

const PATHS = {
  vendorDir: "/repo/vendor/cloud-music-mcp",
  runtimeDir: "/userdata/music/netease/runtime",
  accountPath: "/userdata/music/netease/account.enc",
  resourceBaseDir: "/repo",
};

// Helper: build a fresh MusicService whose paths point at a temp directory
// so logout() can delete a real account.enc / cookies.json without leaking
// state across tests (the default PATHS use hard-coded /userdata paths).
async function freshServiceWithTmpPaths(): Promise<{ svc: MusicService; accountPath: string; runtimeDir: string; cleanup: () => Promise<void> }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "music-logout-"));
  const accountPath = path.join(tmp, "account.enc");
  const runtimeDir = path.join(tmp, "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  const svc = new MusicService({
    vendorDir: "/repo/vendor/cloud-music-mcp",
    runtimeDir,
    accountPath,
    resourceBaseDir: "/repo",
  });
  return {
    svc,
    accountPath,
    runtimeDir,
    cleanup: async () => { await fs.rm(tmp, { recursive: true, force: true }); },
  };
}

describe("MusicService", () => {
  it("getDailyRecommendations rejects when backend not ready (stopped initial)", async () => {
    const s = new MusicService(PATHS);
    expect(s.getBackendState()).toBe("stopped");
    await expect(s.getDailyRecommendations("c1")).rejects.toThrow(/E_BACKEND_NOT_READY/);
  });

  it("searchTracks returns a set after start", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1");
    expect(set.source).toBe("search");
    expect(set.tracks).toHaveLength(1);
    expect(set.tracks[0].artists).toEqual(["Y"]);
  });

  it("searchTracks rejects keyword longer than 100 chars", async () => {
    const s = new MusicService(PATHS);
    await s.start();
    await expect(s.searchTracks("x".repeat(101), "c1")).rejects.toThrow(/E_INVALID_KEYWORD_TOO_LONG/);
  });

  it("searchTracks rejects empty keyword", async () => {
    const s = new MusicService(PATHS);
    await s.start();
    await expect(s.searchTracks("   ", "c1")).rejects.toThrow(/E_INVALID_KEYWORD_EMPTY/);
  });

  it("searchTracks clamps limit to 20", async () => {
    searchTool.mockResolvedValue({ success: true, items: [] });
    const s = new MusicService(PATHS);
    await s.start();
    await s.searchTracks("q", "c1", 999);
    expect(searchTool).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it("presentTracks validates trackIds belong to the set", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1");
    await expect(s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: ["999"] }))
      .rejects.toThrow(/E_TRACK_NOT_IN_SET/);
    const ok = await s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: ["1"] });
    expect(ok.cardRef).toContain(set.setId);
  });

  it("presentTracks limits to 5 selected", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1");
    await expect(s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: ["1", "1", "1", "1", "1", "1"] }))
      .rejects.toThrow(/E_TOO_MANY_SELECTED/);
  });

  it("presentTracks validates reason length", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1");
    await expect(s.presentTracks({ setId: set.setId, conversationId: "c1", trackIds: ["1"], reasons: ["x".repeat(51)] }))
      .rejects.toThrow(/E_REASON_TOO_LONG/);
  });

  it("playTrack rejects non-numeric id", async () => {
    const s = new MusicService(PATHS);
    await expect(s.playTrack("not-num")).rejects.toThrow(/E_INVALID_ID/);
  });

  it("playTrack returns client_unavailable when protocol missing", async () => {
    isRegistered.mockResolvedValue(false);
    const s = new MusicService(PATHS);
    const r = await s.playTrack("123");
    expect(r.state).toBe("client_unavailable");
    expect(r.errorCode).toBe("E_PROTOCOL_NOT_REGISTERED");
  });

  it("playTrack dispatches when protocol registered", async () => {
    isRegistered.mockResolvedValue(true);
    openExternal.mockResolvedValue(undefined);
    const s = new MusicService(PATHS);
    const r = await s.playTrack("123");
    expect(r.state).toBe("dispatched");
    expect(r.resourceType).toBe("song");
    expect(r.resourceId).toBe("123");
  });

  // ── New spec-required methods ──────────────────────────────

  it("getSelectionSet retrieves set by id and conversationId", async () => {
    searchTool.mockResolvedValue({ success: true, items: [{ id: 1, name: "X", artist: "Y" }] });
    const s = new MusicService(PATHS);
    await s.start();
    const set = await s.searchTracks("X", "c1");
    expect(s.getSelectionSet(set.setId, "c1")).toEqual(set);
    expect(s.getSelectionSet(set.setId, "c2")).toBeNull();
  });

  it("getLoginFlowState returns orchestrator flow state", () => {
    const s = new MusicService(PATHS);
    expect(s.getLoginFlowState()).toBe("idle");
  });

  it("getActiveProfile returns null before login", () => {
    const s = new MusicService(PATHS);
    expect(s.getActiveProfile()).toBeNull();
  });

  it("event listeners return unsubscribe functions", () => {
    const s = new MusicService(PATHS);
    const fn = () => {};
    const unsub = s.onBackendStateChange(fn);
    unsub();
    // No assertion needed — just verifying no throw
    expect(true).toBe(true);
  });

  it("shutdown returns a MusicShutdownReport", async () => {
    const s = new MusicService(PATHS);
    const report = await s.shutdown();
    expect(report).toEqual({
      rootProcessPid: undefined,
      transportClosed: true,
      processTreeExited: true,  // no live PID to check
      runtimeRemoved: true,
    });
  });

  it("shutdown is idempotent", async () => {
    const s = new MusicService(PATHS);
    const r1 = await s.shutdown();
    const r2 = await s.shutdown();
    expect(r1).toEqual(r2);
  });

  // ── logout() ───────────────────────────────────────────────

  it("logout() on a fresh service cancels login, closes client, removes account file and runtime cookies, sets signed_out", async () => {
    cancelTool.mockResolvedValue({ ok: true, status: "cancelled" });
    beginTool.mockResolvedValue({ loginSessionId: "sess-1" });

    const { svc, accountPath, runtimeDir, cleanup } = await freshServiceWithTmpPaths();
    try {
      // Seed the vault with a fake encrypted account file (safeStorage is mocked as
      // unavailable so persist() is a no-op; we just drop the file on disk directly).
      await fs.writeFile(accountPath, "seed-account-blob");
      // And a runtime cookies file that logout() must scrub.
      const cookiesPath = path.join(runtimeDir, "cookies.json");
      await fs.writeFile(cookiesPath, JSON.stringify({ MUSIC_U: "old" }));

      // Track that the service was constructed with one MCP client whose close
      // we can later inspect.
      expect(clientInstances).toHaveLength(1);
      const clientInstance = clientInstances[0]!;

      // Bring the service to "ready" and start a login session so the orchestrator
      // actually has a currentSessionId to cancel.
      await svc.start();
      await svc.beginLogin();
      expect(beginTool).toHaveBeenCalledTimes(1);

      await svc.logout();

      // 1. orchestrator.cancelLogin was called -> routed through MCP cancel RPC.
      expect(cancelTool).toHaveBeenCalledTimes(1);
      // 2. client.close was called exactly once on the service's client instance.
      expect(clientInstance.close).toHaveBeenCalledTimes(1);
      // 3. vault.delete removed account.enc.
      await expect(fs.stat(accountPath)).rejects.toThrow(/ENOENT/);
      // 4. runtime cookies.json removed.
      await expect(fs.stat(cookiesPath)).rejects.toThrow(/ENOENT/);
      // 5. accountState reports signed_out.
      expect(svc.getAccountState()).toBe("signed_out");
      expect(svc.getActiveProfile()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("logout() succeeds even when there is no account file and client.close throws", async () => {
    cancelTool.mockResolvedValue({ ok: true, status: "cancelled" });
    beginTool.mockResolvedValue({ loginSessionId: "sess-2" });

    const { svc, accountPath, cleanup } = await freshServiceWithTmpPaths();
    try {
      // Ensure no account.enc exists.
      await expect(fs.stat(accountPath)).rejects.toThrow(/ENOENT/);
      // Force the underlying MCP client's close() to throw — logout must swallow
      // this so the rest of the cleanup still runs.
      expect(clientInstances).toHaveLength(1);
      clientInstances[0]!.close.mockRejectedValueOnce(new Error("transport already closed"));

      // Start the service and a login session so cancelLogin has something to cancel.
      await svc.start();
      await svc.beginLogin();

      await expect(svc.logout()).resolves.toBeUndefined();

      expect(cancelTool).toHaveBeenCalledTimes(1);
      expect(clientInstances[0]!.close).toHaveBeenCalledTimes(1);
      expect(svc.getAccountState()).toBe("signed_out");
    } finally {
      await cleanup();
    }
  });
});