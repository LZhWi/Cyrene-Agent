// inbound-server 同步端点集成测试：验证 /sync/pull /sync/push 的鉴权、路由与合并往返。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (plain: string) => Buffer.from(plain, "utf8"),
    decryptString: (buf: Buffer) => buf.toString("utf8"),
  },
}));

async function req(
  port: number,
  method: string,
  urlPath: string,
  secret?: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret) headers["x-cyrene-channel-secret"] = secret;
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe("inbound-server · sync endpoints", () => {
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-sync-"));
    vi.resetModules();
  });

  afterEach(async () => {
    if (stop) await stop();
    stop = null;
  });

  async function start(): Promise<{ port: number; secret: string }> {
    const { startInboundServer, stopInboundServer } = await import("./inbound-server");
    const { loadChannelsSettings } = await import("./settings-store");
    const handle = await startInboundServer();
    stop = stopInboundServer;
    const secret = loadChannelsSettings().sharedSecret;
    return { port: handle.port, secret };
  }

  it("rejects pull/push without the shared secret", async () => {
    const { port } = await start();
    const pull = await req(port, "GET", "/sync/pull");
    expect(pull.status).toBe(401);
    const push = await req(port, "POST", "/sync/push", undefined, { l0: {}, l1: {} });
    expect(push.status).toBe(401);
  });

  it("pulls a snapshot and accepts a valid push (round-trip merge)", async () => {
    const { memoryStore } = await import("../memory/memory-store");
    await memoryStore.addL2Memory({
      content: "本地记忆",
      triggerText: "t",
      sourceConversationId: "conv",
      isPinned: false,
    });

    const { port, secret } = await start();

    const pull = await req(port, "GET", "/sync/pull", secret);
    expect(pull.status).toBe(200);
    expect(pull.json.ok).toBe(true);
    expect(pull.json.snapshot.l2).toHaveLength(1);

    // 构造一个远端快照 push 回去
    const snapshot = {
      deviceId: "ios-test",
      cursor: Date.now(),
      l0: {
        nickname: "远端",
        preferredName: "",
        occupation: "",
        longTermInterests: "",
        language: "zh-CN",
        permanentNote: "",
        isPinned: false,
        updatedAt: Date.now() + 10_000,
      },
      l1: { recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 0, roundCount: 0 },
      l2: [
        {
          id: "l2_remote_http",
          content: "远端记忆",
          triggerText: "t",
          sourceConversationId: "conv",
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          accessCount: 0,
          weight: 0,
          isPinned: false,
          status: "active",
          syncStatus: "pending_sync",
        },
      ],
      evidence: [],
      reflectionLogs: [],
      conflictLogs: [],
      history: [],
    };

    const push = await req(port, "POST", "/sync/push", secret, snapshot);
    expect(push.status).toBe(200);
    expect(push.json.ok).toBe(true);
    expect(push.json.applied.l2Added).toBe(1);
    expect(push.json.applied.l0Updated).toBe(true);
    expect(push.json.cursor).toBeGreaterThan(0);

    const all = await memoryStore.getAllL2();
    expect(all.some((m) => m.id === "l2_remote_http")).toBe(true);
  });

  it("rejects a malformed push body with 400", async () => {
    const { port, secret } = await start();
    const bad = await req(port, "POST", "/sync/push", secret, { nope: true });
    expect(bad.status).toBe(400);
  });
});

describe("inbound-server · /chat forward", () => {
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-chat-"));
    vi.resetModules();
  });

  afterEach(async () => {
    if (stop) await stop();
    stop = null;
  });

  async function start(): Promise<{ port: number; secret: string; mod: typeof import("./inbound-server") }> {
    const mod = await import("./inbound-server");
    const { loadChannelsSettings } = await import("./settings-store");
    const handle = await mod.startInboundServer();
    stop = mod.stopInboundServer;
    const secret = loadChannelsSettings().sharedSecret;
    return { port: handle.port, secret, mod };
  }

  it("returns 503 when no chat runner is injected", async () => {
    const { port, secret } = await start();
    const res = await req(port, "POST", "/chat", secret, { text: "hi" });
    expect(res.status).toBe(503);
  });

  it("rejects /chat without the shared secret", async () => {
    const { port, mod } = await start();
    mod.setInboundChatRunner(async ({ text }) => ({ reply: `echo:${text}` }));
    const res = await req(port, "POST", "/chat", undefined, { text: "hi" });
    expect(res.status).toBe(401);
    mod.setInboundChatRunner(null);
  });

  it("rejects empty text with 400", async () => {
    const { port, secret, mod } = await start();
    mod.setInboundChatRunner(async ({ text }) => ({ reply: `echo:${text}` }));
    const res = await req(port, "POST", "/chat", secret, { text: "   " });
    expect(res.status).toBe(400);
    mod.setInboundChatRunner(null);
  });

  it("forwards to the injected runner and returns its reply", async () => {
    const { port, secret, mod } = await start();
    const seen: Array<{ sessionId: string; text: string }> = [];
    mod.setInboundChatRunner(async ({ sessionId, text }) => {
      seen.push({ sessionId, text });
      return { reply: `你说了「${text}」` };
    });
    const res = await req(port, "POST", "/chat", secret, { text: "在吗", sessionId: "channel:mobile:main" });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.reply).toBe("你说了「在吗」");
    expect(res.json.sessionId).toBe("channel:mobile:main");
    expect(seen).toEqual([{ sessionId: "channel:mobile:main", text: "在吗" }]);
    mod.setInboundChatRunner(null);
  });

  it("defaults sessionId when omitted", async () => {
    const { port, secret, mod } = await start();
    let gotSession = "";
    mod.setInboundChatRunner(async ({ sessionId }) => {
      gotSession = sessionId;
      return { reply: "ok" };
    });
    const res = await req(port, "POST", "/chat", secret, { text: "hello" });
    expect(res.status).toBe(200);
    expect(gotSession).toBe("channel:mobile:main");
    mod.setInboundChatRunner(null);
  });
});

describe("inbound-server · bind host", () => {
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-bind-"));
    vi.resetModules();
  });

  afterEach(async () => {
    if (stop) await stop();
    stop = null;
  });

  it("defaults to loopback (inboundBindLan=false) and is reachable on 127.0.0.1", async () => {
    const { saveChannelsSettings, loadChannelsSettings } = await import("./settings-store");
    // 默认 false —— 与历史行为一致
    expect(loadChannelsSettings().inboundBindLan).toBe(false);
    const { startInboundServer, stopInboundServer } = await import("./inbound-server");
    const handle = await startInboundServer();
    stop = stopInboundServer;
    const secret = loadChannelsSettings().sharedSecret;
    const res = await req(handle.port, "GET", "/channels/healthz");
    expect(res.status).toBe(200);
    void saveChannelsSettings;
    void secret;
  });

  it("binds LAN (0.0.0.0) when inboundBindLan=true and still serves loopback", async () => {
    const { saveChannelsSettings, loadChannelsSettings } = await import("./settings-store");
    saveChannelsSettings({ inboundBindLan: true });
    expect(loadChannelsSettings().inboundBindLan).toBe(true);
    const { startInboundServer, stopInboundServer } = await import("./inbound-server");
    const handle = await startInboundServer();
    stop = stopInboundServer;
    // 绑 0.0.0.0 时回环仍可达（这是手机同步能连上 PC 的前提）
    const res = await req(handle.port, "GET", "/channels/healthz");
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
  });
});
