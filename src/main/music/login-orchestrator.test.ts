import { describe, it, expect, beforeEach, vi } from "vitest";

const beginTool = vi.fn();
const checkTool = vi.fn();
const cancelTool = vi.fn();
const vaultPersist = vi.fn();

vi.mock("./music-mcp-client", () => ({
  MusicMcpClient: vi.fn().mockImplementation(function () {
    return {
      callAuthTool: (name: string, args: unknown) => {
        if (name === "cyrene_music_login_begin") return beginTool(args);
        if (name === "cyrene_music_login_check") return checkTool(args);
        if (name === "cyrene_music_login_cancel") return cancelTool(args);
        throw new Error("not allowed");
      },
    };
  }),
}));

vi.mock("./cookie-vault", () => ({
  CookieVault: vi.fn().mockImplementation(function () {
    return { persist: vaultPersist };
  }),
}));

import { LoginOrchestrator } from "./login-orchestrator";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

let runtimeDir = "";
let orch: LoginOrchestrator;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "music-runtime-"));
  await fs.writeFile(path.join(runtimeDir, "cookies.json"), JSON.stringify({ MUSIC_U: "u" }));
  beginTool.mockReset(); checkTool.mockReset(); cancelTool.mockReset(); vaultPersist.mockReset();
  vaultPersist.mockResolvedValue(true);
  orch = new LoginOrchestrator({
    client: { callAuthTool: (n: string, a: unknown) => n === "cyrene_music_login_begin" ? beginTool(a) : n === "cyrene_music_login_check" ? checkTool(a) : cancelTool(a) } as never,
    runtimeDir,
    vault: { persist: vaultPersist } as never,
    pollIntervalMs: 10,
  });
});

describe("LoginOrchestrator", () => {
  it("beginLogin returns loginSessionId and qrContent", async () => {
    beginTool.mockResolvedValue({
      loginSessionId: "u1",
      qrContent: "https://music.163.com/login?codekey=u1",
      expiresAt: Date.now() + 120_000,
      pollIntervalMs: 2000,
    });
    const out = await orch.beginLogin() as { loginSessionId: string; qrContent: string; expiresAt: number; pollIntervalMs: number };
    expect(out.loginSessionId).toBe("u1");
    expect(out.qrContent).toContain("u1");
    expect(orch.getFlowState()).toBe("creating_qr");
  });

  it("second beginLogin returns login_already_active", async () => {
    beginTool.mockResolvedValue({ loginSessionId: "u1", qrContent: "x", expiresAt: 0, pollIntervalMs: 0 });
    await orch.beginLogin();
    beginTool.mockResolvedValue({ loginSessionId: "u2", qrContent: "y", expiresAt: 0, pollIntervalMs: 0 });
    const second = await orch.beginLogin() as { status: string; activeSessionId: string };
    expect(second.status).toBe("login_already_active");
    expect(second.activeSessionId).toBe("u1");
  });

  it("polls to authorized, persists cookies exactly once", async () => {
    beginTool.mockResolvedValue({ loginSessionId: "u1", qrContent: "x", expiresAt: Date.now() + 60_000, pollIntervalMs: 5 });
    checkTool
      .mockResolvedValueOnce({ status: "waiting_scan" })
      .mockResolvedValueOnce({ status: "waiting_confirm" })
      .mockResolvedValueOnce({ status: "authorized", credentialsPersisted: true, credentialRevision: 1, profile: { userId: "1", nickname: "alice" } });
    await orch.beginLogin();
    await orch.pollOnce();
    await orch.pollOnce();
    const final = await orch.pollOnce();
    expect(final.status).toBe("authorized");
    expect(vaultPersist).toHaveBeenCalledTimes(1);
    expect(orch.getAccountState()).toBe("signed_in");
  });

  it("does not persist twice for same revision", async () => {
    beginTool.mockResolvedValue({ loginSessionId: "u1", qrContent: "x", expiresAt: 0, pollIntervalMs: 5 });
    const ok = { status: "authorized", credentialsPersisted: true, credentialRevision: 1, profile: { userId: "1", nickname: "a" } };
    checkTool.mockResolvedValue(ok);
    await orch.beginLogin();
    await orch.pollOnce();
    const r2 = await orch.pollOnce();
    expect(r2.status).toBe("authorized");
    expect(vaultPersist).toHaveBeenCalledTimes(1);
  });

  it("cancel after authorized does not change account state", async () => {
    beginTool.mockResolvedValue({ loginSessionId: "u1", qrContent: "x", expiresAt: 0, pollIntervalMs: 5 });
    checkTool.mockResolvedValue({ status: "authorized", credentialsPersisted: true, credentialRevision: 1, profile: { userId: "1", nickname: "a" } });
    await orch.beginLogin();
    await orch.pollOnce();
    await orch.cancelLogin();
    expect(orch.getAccountState()).toBe("signed_in");
  });
});
