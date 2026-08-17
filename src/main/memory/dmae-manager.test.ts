// L2 DMAE 工作记忆真实场景测试：
// - 位次梯度：top-1 召回涨 36 分，驻留 2~3 轮后自然衰减出局
// - 唤醒：冷条目被重新召回时拉回工作集（threshold+wakeBonus）
// - 饱和：repeatWindow 内重复注入的条目召回奖励打折，防单条刷屏
// - 选择：pinned 常驻 + 活跃集补位，冲突条目不进 DMAE 补位通道
// - 持久化：状态防抖落盘、重启（reset 后重读）恢复驻留集
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { L2DmaeState, L2Memory } from "./memory-types";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  snapshot: { states: {} as Record<string, L2DmaeState>, round: 0 },
}));

vi.mock("../runtime/runtime-paths", () => ({
  getUserDataDir: () => mocks.dataDir,
}));
vi.mock("./memory-store", () => ({
  memoryStore: {
    getL2DmaeSnapshot: vi.fn(async () => ({
      states: { ...mocks.snapshot.states },
      round: mocks.snapshot.round,
    })),
    setL2DmaeSnapshot: vi.fn(async (states: Record<string, L2DmaeState>, round: number) => {
      mocks.snapshot = { states: { ...states }, round };
    }),
  },
}));
vi.mock("./memory-trace", () => ({
  appendMemoryTrace: vi.fn(),
}));

import { l2DmaeManager, isL2DmaeEnabled, selectEntries, simulateTurn, L2_DMAE_PARAMS } from "./dmae-manager";

function makeL2(overrides: Partial<L2Memory> & { id: string }): L2Memory {
  return {
    content: `记忆 ${overrides.id}`,
    triggerText: "触发原话",
    sourceConversationId: "chat-1",
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    weight: 10,
    isPinned: false,
    status: "active",
    syncStatus: "synced",
    ragId: `rag_${overrides.id}`,
    evidenceIds: [],
    ...overrides,
  };
}

function entry(l2Id: string, text = `记忆 ${l2Id}`) {
  return { id: `rag_${l2Id}`, text, createdAt: Date.now(), score: 0.8, metadata: { l2Id } };
}

function freshState(overrides: Partial<L2DmaeState> = {}): L2DmaeState {
  return { activation: 0, userSilence: 0, modelSilence: 0, lastInjectedRound: -1, round: 0, ...overrides };
}

function writeSettings(content: string): void {
  fs.writeFileSync(path.join(mocks.dataDir, "model-settings.json"), content, "utf8");
}

describe("simulateTurn 状态演算", () => {
  it("rank-1 召回涨 36 分，静默 3 轮后跌破阈值退出活跃集", () => {
    // 真实场景：用户聊了某个话题，之后几轮换了说法——
    // 该记忆应先驻留、再自然淡出，而不是立刻消失或永久霸榜。
    let states = simulateTurn(new Map(), ["l2_topic"], 1);
    expect(states.get("l2_topic")?.activation).toBe(36);

    states = simulateTurn(states, [], 2);
    expect(states.get("l2_topic")?.activation).toBeCloseTo(34.8, 5);
    expect(states.get("l2_topic")!.activation).toBeGreaterThanOrEqual(L2_DMAE_PARAMS.promptThreshold);

    states = simulateTurn(states, [], 3);
    // 理论上恰为 30（36 - 1.2 - 4.8）；浮点误差内仍应视为活跃
    expect(states.get("l2_topic")!.activation).toBeCloseTo(30, 5);

    states = simulateTurn(states, [], 4);
    expect(states.get("l2_topic")!.activation).toBeLessThan(L2_DMAE_PARAMS.promptThreshold);
  });

  it("wakes a cold entry back into the working set when it is recalled again", () => {
    // 真实场景：三周前聊过的爱好（activation=0 冷态）突然又被提起，应当场回到工作集。
    // rank-0 召回奖励 36 本就高于唤醒底线 threshold+wakeBonus=35，取二者较大值
    const states = simulateTurn(new Map([["l2_old", freshState({ activation: 0, userSilence: 30 })]]), ["l2_old"], 5);
    expect(states.get("l2_old")?.activation).toBeGreaterThanOrEqual(
      L2_DMAE_PARAMS.promptThreshold + L2_DMAE_PARAMS.wakeBonus,
    );
    // 低位次冷条目靠唤醒底线拉回（rank-3 奖励仅 1 分，不足以自己爬回 30）
    const lowRank = simulateTurn(new Map([["l2_old", freshState({ activation: 0, userSilence: 30 })]]), ["a", "b", "c", "l2_old"], 5);
    expect(lowRank.get("l2_old")?.activation).toBe(L2_DMAE_PARAMS.promptThreshold + L2_DMAE_PARAMS.wakeBonus);
  });

  it("discounts recall reward inside the repeat window to prevent one memory from saturating", () => {
    // 真实场景：同一条记忆连续多轮被检索命中，activation 不应无限堆满 100
    const seeded = new Map([["l2_hot", freshState({ activation: 40, lastInjectedRound: 4 })]]);
    const saturated = simulateTurn(seeded, ["l2_hot"], 6); // round-lastInjected=2 < 6 → 打折
    const fresh = simulateTurn(new Map([["l2_hot", freshState({ activation: 40, lastInjectedRound: -1 })]]), ["l2_hot"], 6);
    expect(saturated.get("l2_hot")!.activation).toBeLessThan(fresh.get("l2_hot")!.activation);
    expect(fresh.get("l2_hot")!.activation - 40).toBeCloseTo(36, 5);
  });

  it("drops states of deleted memories instead of carrying them forever", () => {
    const states = simulateTurn(
      new Map([["l2_gone", freshState({ activation: 50 })], ["l2_alive", freshState({ activation: 50 })]]),
      [],
      2,
      new Set(["l2_alive"]),
    );
    expect(states.has("l2_gone")).toBe(false);
    expect(states.has("l2_alive")).toBe(true);
  });
});

describe("selectEntries 注入选择", () => {
  it("unions recall results with pinned and active-set entries, capped by maxInject", () => {
    // 真实场景：当轮检索没召回 pinned 的"重要约定"，它仍应常驻注入
    const allL2 = [
      makeL2({ id: "l2_recall" }),
      makeL2({ id: "l2_pinned", isPinned: true }),
      makeL2({ id: "l2_active" }),
      makeL2({ id: "l2_cold" }),
    ];
    const states = new Map<string, L2DmaeState>([
      ["l2_active", freshState({ activation: 45 })],
      ["l2_cold", freshState({ activation: 10 })],
    ]);

    const selected = selectEntries([entry("l2_recall")], allL2, states);
    const ids = selected.map((e) => e.metadata?.l2Id);

    expect(ids).toContain("l2_recall");
    expect(ids).toContain("l2_pinned");
    expect(ids).toContain("l2_active");
    expect(ids).not.toContain("l2_cold");
    expect(selected.length).toBeLessThanOrEqual(L2_DMAE_PARAMS.maxInject);
  });

  it("keeps conflicted memories out of the DMAE top-up channel until resolved", () => {
    // 真实场景：未裁决的冲突记忆不应被 DMAE 主动补位，只能走检索通道带 ⚠️ 措辞求证
    const allL2 = [
      makeL2({ id: "l2_conflict", conflictWith: ["rag_other"] }),
      makeL2({ id: "l2_ok" }),
    ];
    const states = new Map<string, L2DmaeState>([
      ["l2_conflict", freshState({ activation: 80 })],
      ["l2_ok", freshState({ activation: 60 })],
    ]);

    const selected = selectEntries([], allL2, states);
    const ids = selected.map((e) => e.metadata?.l2Id);
    expect(ids).toContain("l2_ok");
    expect(ids).not.toContain("l2_conflict");
  });

  it("keeps expired (superseded) memories out of pinned and active-set top-up", () => {
    // 真实场景：被纠正/取代的旧事实（validTo 已过）即使 pinned 或高激活也不应驻留注入
    const allL2 = [
      makeL2({ id: "l2_expired_pinned", isPinned: true, validTo: Date.now() - 1000 }),
      makeL2({ id: "l2_expired_active", validTo: Date.now() - 1000 }),
      makeL2({ id: "l2_future", validFrom: Date.now() + 100000 }),
      makeL2({ id: "l2_ok", validFrom: Date.now() - 100000 }),
    ];
    const states = new Map<string, L2DmaeState>([
      ["l2_expired_active", freshState({ activation: 80 })],
      ["l2_future", freshState({ activation: 70 })],
      ["l2_ok", freshState({ activation: 60 })],
    ]);

    const selected = selectEntries([], allL2, states);
    const ids = selected.map((e) => e.metadata?.l2Id);
    expect(ids).toContain("l2_ok");
    expect(ids).not.toContain("l2_expired_pinned");
    expect(ids).not.toContain("l2_expired_active");
    expect(ids).not.toContain("l2_future");
  });
});

describe("L2DmaeManager 与开关", () => {
  beforeEach(() => {
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-dmae-"));
    mocks.snapshot = { states: {}, round: 0 };
    l2DmaeManager.resetForTest();
  });

  afterEach(() => {
    l2DmaeManager.resetForTest();
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("is disabled by default and honors memoryDmaeEnabled in model-settings.json", () => {
    expect(isL2DmaeEnabled()).toBe(false);
    writeSettings(JSON.stringify({ provider: "mock", memoryDmaeEnabled: true }));
    expect(isL2DmaeEnabled()).toBe(true);
  });

  it("persists states on flush and restores the working set after restart", async () => {
    // 真实场景：应用重启后，上一轮正在聊的话题记忆不应从工作集丢失
    const allL2 = [makeL2({ id: "l2_topic" })];
    await l2DmaeManager.applyTurn([entry("l2_topic")], allL2);
    await l2DmaeManager.flushNow();
    expect(mocks.snapshot.round).toBe(1);
    expect(mocks.snapshot.states["l2_topic"].activation).toBe(36);

    // 模拟重启：单例内存态清零，从盘上恢复
    l2DmaeManager.resetForTest();
    const states = await l2DmaeManager.describeStates();
    expect(states.find((s) => s.l2Id === "l2_topic")?.activation).toBe(36);
    expect(states.find((s) => s.l2Id === "l2_topic")?.state).toBe("Active");
  });

  it("previewTurn simulates the next turn without committing any state", async () => {
    // 真实场景：设置页沙箱与 trackState:false 的只读调用不能污染正式状态表
    const allL2 = [makeL2({ id: "l2_topic" })];
    const preview = await l2DmaeManager.previewTurnDetailed([entry("l2_topic")], allL2);
    expect(preview.selected.map((e) => e.metadata?.l2Id)).toContain("l2_topic");
    expect(preview.states.find((s) => s.l2Id === "l2_topic")?.activation).toBe(36);

    expect(mocks.snapshot.round).toBe(0);
    expect(Object.keys(mocks.snapshot.states)).toHaveLength(0);
    const committed = await l2DmaeManager.describeStates();
    expect(committed).toHaveLength(0);
  });
});
