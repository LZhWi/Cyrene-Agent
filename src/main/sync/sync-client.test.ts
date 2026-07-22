// sync-client 集成测试：用真实 fetch 打真实 inbound-server，验证 RN↔PC 往返契约。
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

describe("SyncClient · against live inbound-server", () => {
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-client-"));
    vi.resetModules();
  });

  afterEach(async () => {
    if (stop) await stop();
    stop = null;
  });

  it("pulls then pushes a snapshot, PC merges it", async () => {
    const { memoryStore } = await import("../memory/memory-store");
    await memoryStore.addL2Memory({
      content: "PC记忆",
      triggerText: "t",
      sourceConversationId: "conv",
      isPinned: false,
    });

    const { startInboundServer, stopInboundServer } = await import("../channels/inbound-server");
    const { loadChannelsSettings } = await import("../channels/settings-store");
    const { SyncClient } = await import("./sync-client");

    const handle = await startInboundServer();
    stop = stopInboundServer;
    const secret = loadChannelsSettings().sharedSecret;

    const client = new SyncClient({
      baseUrl: `http://127.0.0.1:${handle.port}`,
      secret,
      deviceId: "ios-client",
    });

    const pulled = await client.pull(0);
    expect(pulled.ok).toBe(true);
    expect(pulled.snapshot.l2.some((m) => m.content === "PC记忆")).toBe(true);

    // 客户端造一条本地记忆并 push
    const snapshot = { ...pulled.snapshot, deviceId: "ignored" };
    snapshot.l2 = [
      {
        id: "l2_from_client",
        content: "手机记忆",
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
    ];

    const pushed = await client.push(snapshot);
    expect(pushed.ok).toBe(true);
    expect(pushed.applied.l2Added).toBe(1);
    expect(pushed.cursor).toBeGreaterThan(0);

    const all = await memoryStore.getAllL2();
    expect(all.some((m) => m.id === "l2_from_client")).toBe(true);
  });

  it("throws SyncError on a wrong secret", async () => {
    const { startInboundServer, stopInboundServer } = await import("../channels/inbound-server");
    const { SyncClient, SyncError } = await import("./sync-client");

    const handle = await startInboundServer();
    stop = stopInboundServer;

    const client = new SyncClient({
      baseUrl: `http://127.0.0.1:${handle.port}`,
      secret: "wrong-secret",
      deviceId: "ios-client",
    });

    await expect(client.pull(0)).rejects.toBeInstanceOf(SyncError);
  });
});
