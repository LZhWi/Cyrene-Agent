import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}));

describe("sync/sync-service", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-service-"));
    vi.resetModules();
  });

  it("builds a full snapshot of memory and history", async () => {
    const { memoryStore } = await import("../memory/memory-store");
    const { appendHistory } = await import("../channels/history-log");
    const { buildSyncSnapshot } = await import("./sync-service");

    await memoryStore.addL2Memory({
      content: "用户喜欢香菇",
      triggerText: "我喜欢香菇",
      sourceConversationId: "conv",
      isPinned: false,
    });
    await memoryStore.updateL0({ nickname: "P宝" });
    appendHistory("channel:feishu:abc", "user", "在吗");
    appendHistory("channel:feishu:abc", "assistant", "在的呀");

    const snap = await buildSyncSnapshot("pc-test", 0);
    expect(snap.deviceId).toBe("pc-test");
    expect(snap.l2).toHaveLength(1);
    expect(snap.l0.nickname).toBe("P宝");
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0].entries).toHaveLength(2);
    expect(snap.cursor).toBeGreaterThan(0);
  });

  it("does not pull or restore legacy WeChat channel history", async () => {
    const { appendHistory, readHistoryByStem, stemForSession } = await import("../channels/history-log");
    const { buildSyncSnapshot, applySyncSnapshot } = await import("./sync-service");

    const localWechatStem = stemForSession("channel:wechat:local");
    appendHistory("channel:wechat:local", "user", "旧微信消息");
    appendHistory("channel:feishu:local", "user", "飞书消息");

    const snap = await buildSyncSnapshot("pc-test", 0);
    expect(snap.history.some((bundle) => bundle.stem === localWechatStem)).toBe(false);
    expect(snap.history.some((bundle) => bundle.stem.startsWith("channel_feishu_"))).toBe(true);

    const remoteWechatStem = stemForSession("channel:wechat:remote");
    const result = await applySyncSnapshot({
      ...snap,
      deviceId: "mobile-test",
      history: [{
        stem: remoteWechatStem,
        entries: [{ at: "2026-09-20T00:00:00.000Z", role: "user", content: "不应恢复" }],
      }],
    });
    expect(result.applied.historyAdded).toBe(0);
    expect(readHistoryByStem(remoteWechatStem)).toEqual([]);
  });

  it("applies a pushed snapshot: adds L2, history, and LWW L0", async () => {
    const { memoryStore } = await import("../memory/memory-store");
    const { readHistoryByStem, stemForSession } = await import("../channels/history-log");
    const { applySyncSnapshot } = await import("./sync-service");
    const { buildSyncSnapshot } = await import("./sync-service");

    // 本地已有一条记忆
    await memoryStore.addL2Memory({
      content: "本地记忆",
      triggerText: "t",
      sourceConversationId: "conv",
      isPinned: false,
    });

    const stem = stemForSession("channel:feishu:remote");
    const incoming = {
      deviceId: "ios-test",
      cursor: Date.now(),
      l0: {
        nickname: "远端昵称",
        preferredName: "",
        occupation: "",
        longTermInterests: "",
        language: "zh-CN",
        permanentNote: "",
        isPinned: false,
        updatedAt: Date.now() + 10_000, // 更新更晚 → 应覆盖
      },
      l1: {
        recentGoals: "",
        recentPreferences: "",
        currentProject: "",
        generatedAt: 0,
        roundCount: 0,
      },
      l2: [
        {
          id: "l2_remote_1",
          content: "远端记忆",
          triggerText: "t",
          sourceConversationId: "conv",
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
          accessCount: 0,
          weight: 0,
          isPinned: false,
          status: "active" as const,
          syncStatus: "pending_sync" as const,
        },
      ],
      evidence: [],
      reflectionLogs: [],
      conflictLogs: [],
      history: [
        {
          stem,
          entries: [
            { at: "2024-05-01T00:00:01Z", role: "user" as const, content: "远端消息" },
          ],
        },
      ],
    };

    const { applied, cursor } = await applySyncSnapshot(incoming);
    expect(applied.l2Added).toBe(1);
    expect(applied.historyAdded).toBe(1);
    expect(applied.l0Updated).toBe(true);
    expect(cursor).toBeGreaterThan(0);

    const all = await memoryStore.getAllL2();
    expect(all.map((m) => m.content).sort()).toEqual(["本地记忆", "远端记忆"]);
    const l0 = await memoryStore.getL0();
    expect(l0.nickname).toBe("远端昵称");

    const stored = readHistoryByStem(stem);
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("远端消息");

    // push 的记忆也应出现在下一次 pull 快照中
    const snap = await buildSyncSnapshot("pc-test", 0);
    expect(snap.l2.some((m) => m.id === "l2_remote_1")).toBe(true);
  });

  it("is idempotent: re-applying the same snapshot adds nothing", async () => {
    const { memoryStore } = await import("../memory/memory-store");
    const { buildSyncSnapshot, applySyncSnapshot } = await import("./sync-service");

    await memoryStore.addL2Memory({
      content: "记忆A",
      triggerText: "t",
      sourceConversationId: "conv",
      isPinned: false,
    });
    const { appendHistory } = await import("../channels/history-log");
    appendHistory("channel:feishu:x", "user", "hi");

    const snap = await buildSyncSnapshot("pc-test", 0);
    const first = await applySyncSnapshot(snap);
    const second = await applySyncSnapshot(snap);

    expect(second.applied.l2Added).toBe(0);
    expect(second.applied.historyAdded).toBe(0);
    expect(second.applied.l2Updated).toBe(0);

    const all = await memoryStore.getAllL2();
    expect(all).toHaveLength(1);
    // first 的自合并也不应重复
    expect(first.applied.l2Added).toBe(0);
  });

  it("respects the since cursor when building incremental snapshots", async () => {
    const { memoryStore } = await import("../memory/memory-store");
    const { buildSyncSnapshot } = await import("./sync-service");

    const older = await memoryStore.addL2Memory({
      content: "旧记忆",
      triggerText: "t",
      sourceConversationId: "conv",
      isPinned: false,
    });

    // 用一个介于两条记忆之间的游标
    const cursor = older.createdAt + 1;
    await new Promise((r) => setTimeout(r, 5));
    await memoryStore.addL2Memory({
      content: "新记忆",
      triggerText: "t",
      sourceConversationId: "conv",
      isPinned: false,
    });

    const snap = await buildSyncSnapshot("pc-test", cursor);
    // 旧记忆的 createdAt < cursor 且未被访问，应被过滤
    expect(snap.l2.every((m) => m.content !== "旧记忆")).toBe(true);
    expect(snap.l2.some((m) => m.content === "新记忆")).toBe(true);
  });
});
