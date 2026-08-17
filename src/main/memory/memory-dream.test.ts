// memory-dream.test.ts — 梦境蒸馏三段管线单测
// 覆盖：开关与模型解析、瘦身评分/规划、沉淀叙事、蒸馏合并、中止路径、调度器空闲窗口。
// 惯例与 memory-judge.test.ts 一致：vi.hoisted mocks + vi.mock 工厂 + 临时 dataDir + stubGlobal fetch。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { L2Memory } from "./memory-types";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  ragReady: true,
  ragEntries: [] as Array<{ id: string; embedding: number[] }>,
  l2Memories: [] as L2Memory[],
  llmResponses: [] as string[],
  capturedPrompts: [] as Array<Array<{ role: string; content: string }>>,
  narratives: [] as Array<{ id: string; createdAt: number; text: string }>,
  mergeBatches: [] as Array<{ ids: string[]; mergedIntoId: string }>,
  statusUpdates: [] as Array<{ ids: string[]; status: string }>,
  addedSummaries: [] as Array<{ id: string; content: string }>,
  deletedVectors: [] as string[],
  enqueueCalls: [] as string[],
  abortOnStatusUpdate: null as AbortController | null,
}));

vi.mock("../runtime/runtime-paths", () => ({
  getUserDataDir: () => mocks.dataDir,
}));
vi.mock("../token-usage-store", () => ({
  recordUsage: vi.fn(),
}));
vi.mock("../llm-queue", () => ({
  enqueueLLMTask: async (name: string, fn: () => Promise<unknown>) => {
    mocks.enqueueCalls.push(name);
    return fn();
  },
}));
vi.mock("../orchestrator/vendors", () => ({
  getAdapterForConfig: () => ({
    buildRequest: (req: { messages: Array<{ role: string; content: string }> }) => {
      mocks.capturedPrompts.push(req.messages);
      return { url: "http://mock.local/chat", headers: {}, body: "{}" };
    },
    parseResponse: () => ({ text: mocks.llmResponses.shift() ?? "" }),
  }),
}));
vi.mock("./memory-store", () => ({
  memoryStore: {
    getAllL2: async () => mocks.l2Memories.map((m) => ({ ...m })),
    updateL2Status: async (ids: string[], status: string) => {
      mocks.statusUpdates.push({ ids, status });
      if (mocks.abortOnStatusUpdate) mocks.abortOnStatusUpdate.abort();
      for (const m of mocks.l2Memories) if (ids.includes(m.id)) m.status = status as L2Memory["status"];
    },
    addL2Memory: async (input: { content: string }) => {
      const m = { id: `sum_${mocks.addedSummaries.length + 1}`, content: input.content };
      mocks.addedSummaries.push(m);
      mocks.l2Memories.push({ ...(input as unknown as L2Memory), id: m.id });
      return m;
    },
    markL2SyncStatus: vi.fn(async () => {}),
    mergeL2Batch: async (ids: string[], mergedIntoId: string) => {
      mocks.mergeBatches.push({ ids, mergedIntoId });
      for (const m of mocks.l2Memories) {
        if (ids.includes(m.id)) { m.status = "merged"; m.mergedInto = mergedIntoId; }
      }
    },
    deleteL2: async (id: string) => {
      mocks.l2Memories = mocks.l2Memories.filter((m) => m.id !== id);
    },
    appendDreamNarrative: async (text: string) => {
      const n = { id: `n_${mocks.narratives.length + 1}`, createdAt: Date.now(), text };
      mocks.narratives.push(n);
      return n;
    },
    getDreamNarratives: async () => [...mocks.narratives],
  },
}));
vi.mock("../rag/index", () => ({
  isUserMemoryVectorStoreReady: () => mocks.ragReady,
  getEntriesBySource: (source: string) => (source === "user_memory" ? mocks.ragEntries : []),
  addL2MemoryVector: async (_text: string, l2Id: string) => `rag_${l2Id}`,
  deleteUserMemoryVectors: async (ids: string[]) => { mocks.deletedVectors.push(...ids); },
}));
vi.mock("./memory-trace", () => ({
  appendMemoryTrace: vi.fn(),
}));

import {
  DREAM_PARAMS,
  clusterDreamGroups,
  dreamSlimScore,
  isMemoryDreamEnabled,
  loadDreamState,
  notifyDreamUserActivity,
  planSlimDown,
  resetDreamSchedulerForTest,
  resolveDreamModel,
  runDreamCycle,
  startDreamScheduler,
} from "./memory-dream";

let l2Seq = 0;
function makeL2(overrides: Partial<L2Memory> = {}): L2Memory {
  l2Seq += 1;
  const now = Date.now();
  return {
    id: `m_${l2Seq}`,
    content: `记忆条目 ${l2Seq}`,
    triggerText: "触发语",
    sourceConversationId: "chat-1",
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 1,
    weight: 0.6,
    isPinned: false,
    status: "active",
    ...overrides,
  };
}

function writeSettings(settings: Record<string, unknown>): void {
  fs.writeFileSync(path.join(mocks.dataDir, "model-settings.json"), JSON.stringify(settings), "utf8");
}

const DAY = 24 * 60 * 60 * 1000;
const NARRATIVE_OK = "这些印象沉淀下来后，我发现我们的默契就藏在这些琐碎里，值得我一直记着。";

beforeEach(() => {
  mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-dream-"));
  mocks.ragReady = true;
  mocks.ragEntries = [];
  mocks.l2Memories = [];
  mocks.llmResponses = [];
  mocks.capturedPrompts = [];
  mocks.narratives = [];
  mocks.mergeBatches = [];
  mocks.statusUpdates = [];
  mocks.addedSummaries = [];
  mocks.deletedVectors = [];
  mocks.enqueueCalls = [];
  mocks.abortOnStatusUpdate = null;
  l2Seq = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
  resetDreamSchedulerForTest();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fs.rmSync(mocks.dataDir, { recursive: true, force: true });
});

describe("开关与模型解析", () => {
  it("默认关闭：无 model-settings.json 或字段缺失都算关", () => {
    expect(isMemoryDreamEnabled()).toBe(false);
    writeSettings({ provider: "p", baseUrl: "b", model: "m", apiKey: "k" });
    expect(isMemoryDreamEnabled()).toBe(false);
    writeSettings({ memoryDreamEnabled: "true" });
    expect(isMemoryDreamEnabled()).toBe(false);
  });

  it("memoryDreamEnabled === true 才启用", () => {
    writeSettings({ memoryDreamEnabled: true });
    expect(isMemoryDreamEnabled()).toBe(true);
  });

  it("无 dream 段时跟随主模型", () => {
    writeSettings({ provider: "主家", baseUrl: "http://main.local", model: "main-1", apiKey: "mk" });
    const cfg = resolveDreamModel();
    expect(cfg.provider).toBe("主家");
    expect(cfg.model).toBe("main-1");
    expect(cfg.apiKey).toBe("mk");
  });

  it("dream 段四要素齐全时使用专用模型", () => {
    writeSettings({
      provider: "主家", baseUrl: "http://main.local", model: "main-1", apiKey: "mk",
      dream: { provider: "梦家", baseUrl: "http://dream.local", model: "dream-1", apiKey: "dk" },
    });
    const cfg = resolveDreamModel();
    expect(cfg.provider).toBe("梦家");
    expect(cfg.baseUrl).toBe("http://dream.local");
    expect(cfg.model).toBe("dream-1");
    expect(cfg.apiKey).toBe("dk");
  });

  it("dream 段缺要素时整体回退主模型（不接受半截配置）", () => {
    writeSettings({
      provider: "主家", baseUrl: "http://main.local", model: "main-1", apiKey: "mk",
      dream: { provider: "梦家", baseUrl: "http://dream.local", model: "dream-1" },
    });
    const cfg = resolveDreamModel();
    expect(cfg.provider).toBe("主家");
    expect(cfg.apiKey).toBe("mk");
  });
});

describe("瘦身评分与规划", () => {
  it("评分 = weight × 时近度：新鲜记忆比久远记忆分高", () => {
    const now = Date.now();
    const fresh = makeL2({ weight: 0.5, lastAccessedAt: now });
    const stale = makeL2({ weight: 0.5, lastAccessedAt: now - 30 * DAY, createdAt: now - 30 * DAY });
    expect(dreamSlimScore(fresh, now)).toBeCloseTo(0.5, 5);
    expect(dreamSlimScore(stale, now)).toBeCloseTo(0.25, 5);
  });

  it("未超容量时不做任何降级", () => {
    const all = [makeL2(), makeL2()];
    const plan = planSlimDown(all, Date.now());
    expect(plan.toAging).toHaveLength(0);
    expect(plan.toArchive).toHaveLength(0);
  });

  it("active 超上限：最低分先降为 aging，pinned 豁免", () => {
    const now = Date.now();
    const pinned = makeL2({ isPinned: true, weight: 0.01, lastAccessedAt: now - 300 * DAY });
    const low = makeL2({ weight: 0.2, lastAccessedAt: now - 90 * DAY });
    const high = makeL2({ weight: 0.9, lastAccessedAt: now });
    const mid = makeL2({ weight: 0.5, lastAccessedAt: now - 10 * DAY });
    const plan = planSlimDown([pinned, low, high, mid], now, { ...DREAM_PARAMS, activeCap: 2 });
    // 4 条 active 超 2 → 降 2 条；pinned 豁免，剩下 low/mid 里 low 分最低
    expect(plan.toAging).toHaveLength(2);
    expect(plan.toAging).toContain(low.id);
    expect(plan.toAging).not.toContain(pinned.id);
    expect(plan.toAging).not.toContain(high.id);
  });

  it("全库超上限：aging 池最低分归档，pinned 豁免", () => {
    const now = Date.now();
    const agingLow = makeL2({ status: "aging", weight: 0.1, lastAccessedAt: now - 120 * DAY });
    const agingHigh = makeL2({ status: "aging", weight: 0.8, lastAccessedAt: now - 5 * DAY });
    const agingPinned = makeL2({ status: "aging", isPinned: true, weight: 0.01 });
    const plan = planSlimDown([agingLow, agingHigh, agingPinned], now, { ...DREAM_PARAMS, activeCap: 300, totalCap: 2 });
    expect(plan.toArchive).toEqual([agingLow.id]);
  });
});

describe("聚类", () => {
  it("余弦达标且 ≥ mergeMinGroup 才成组", () => {
    const aging = (id: string): L2Memory => makeL2({ id, status: "aging", ragId: `rag_${id}` });
    const candidates = [
      { l2: aging("a"), embedding: [1, 0, 0] },
      { l2: aging("b"), embedding: [0.99, 0.05, 0] },
      { l2: aging("c"), embedding: [0.98, 0.1, 0] },
      { l2: aging("d"), embedding: [0, 1, 0] },
    ];
    const groups = clusterDreamGroups(candidates, { ...DREAM_PARAMS, mergeMinGroup: 3 });
    expect(groups).toHaveLength(1);
    expect(groups[0].map((g) => g.l2.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("阈值收紧后同批数据不成组", () => {
    const aging = (id: string): L2Memory => makeL2({ id, status: "aging", ragId: `rag_${id}` });
    const candidates = [
      { l2: aging("a"), embedding: [1, 0, 0] },
      { l2: aging("b"), embedding: [0.9, 0.3, 0] },
      { l2: aging("c"), embedding: [0.85, 0.4, 0] },
    ];
    const groups = clusterDreamGroups(candidates, { ...DREAM_PARAMS, mergeSimilarity: 0.99 });
    expect(groups).toHaveLength(0);
  });
});

describe("runDreamCycle", () => {
  beforeEach(() => {
    // LLM 路径需要 apiKey：callDreamLLM 读 model-settings.json，缺失直接抛 missing api key
    writeSettings({ provider: "mock", baseUrl: "http://mock.local", model: "mock-1", apiKey: "k1" });
  });

  it("RAG 未就绪时跳过且不记水位", async () => {
    mocks.ragReady = false;
    const result = await runDreamCycle();
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("rag_unavailable");
  });

  it("已中止的信号直接返回 aborted_before_start", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runDreamCycle({ signal: controller.signal });
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe("aborted_before_start");
  });

  it("瘦身后立即中止：返回 aborted_before_sediment，不发起 LLM 调用", async () => {
    const now = Date.now();
    mocks.l2Memories = [makeL2({ weight: 0.1 }), makeL2({ weight: 0.9 })];
    const controller = new AbortController();
    mocks.abortOnStatusUpdate = controller;
    const result = await runDreamCycle({ signal: controller.signal, params: { activeCap: 1 } });
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe("aborted_before_sediment");
    expect(result.demotedToAging).toBe(1);
    expect(mocks.capturedPrompts).toHaveLength(0);
    expect(mocks.narratives).toHaveLength(0);
  });

  it("无降级条目时不写叙事（不调沉淀 LLM）", async () => {
    mocks.l2Memories = [makeL2(), makeL2()];
    const result = await runDreamCycle();
    expect(result.status).toBe("completed");
    expect(result.demotedToAging).toBe(0);
    expect(result.narrativeWritten).toBe(false);
    expect(mocks.capturedPrompts).toHaveLength(0);
  });

  it("完整三段：降级 → 沉淀叙事 → 合并 aging 组", async () => {
    const now = Date.now();
    // 3 条 active（activeCap=1 → 降 2 条）+ 3 条同向量的 aging（成 1 组）
    mocks.l2Memories = [
      makeL2({ weight: 0.9, lastAccessedAt: now }),
      makeL2({ weight: 0.2, lastAccessedAt: now - 60 * DAY }),
      makeL2({ weight: 0.3, lastAccessedAt: now - 40 * DAY }),
      makeL2({ id: "ag1", status: "aging", ragId: "rag_ag1" }),
      makeL2({ id: "ag2", status: "aging", ragId: "rag_ag2" }),
      makeL2({ id: "ag3", status: "aging", ragId: "rag_ag3" }),
    ];
    mocks.ragEntries = [
      { id: "rag_ag1", embedding: [1, 0, 0] },
      { id: "rag_ag2", embedding: [0.99, 0.05, 0] },
      { id: "rag_ag3", embedding: [0.98, 0.1, 0] },
    ];
    mocks.llmResponses = [NARRATIVE_OK, "三条相近印象的合并总结。"];

    const result = await runDreamCycle({ params: { activeCap: 1 } });

    expect(result.status).toBe("completed");
    expect(result.demotedToAging).toBe(2);
    expect(result.narrativeWritten).toBe(true);
    expect(result.mergedGroups).toBe(1);
    expect(result.mergedEntries).toBe(3);
    // 叙事写入 + 内容来自 LLM
    expect(mocks.narratives).toHaveLength(1);
    expect(mocks.narratives[0].text).toBe(NARRATIVE_OK);
    // 沉淀 prompt 只包含被降级的条目
    const sedimentPrompt = mocks.capturedPrompts[0].find((m) => m.role === "user")?.content ?? "";
    expect(sedimentPrompt).toContain("沉淀");
    // 合并事务：源条目标 merged，总结条目入库，旧向量清理
    expect(mocks.mergeBatches).toHaveLength(1);
    expect(mocks.mergeBatches[0].ids.sort()).toEqual(["ag1", "ag2", "ag3"]);
    expect(mocks.mergeBatches[0].mergedIntoId).toBe("sum_1");
    expect(mocks.addedSummaries).toHaveLength(1);
    expect(mocks.deletedVectors).toEqual(expect.arrayContaining(["rag_ag1", "rag_ag2", "rag_ag3"]));
    const merged = mocks.l2Memories.filter((m) => m.status === "merged");
    expect(merged).toHaveLength(3);
    expect(merged.every((m) => m.mergedInto === "sum_1")).toBe(true);
  });

  it("沉淀输出过短时跳过叙事，但其余阶段照常", async () => {
    mocks.l2Memories = [makeL2({ weight: 0.1 }), makeL2({ weight: 0.9 })];
    mocks.llmResponses = ["太短了"];
    const result = await runDreamCycle({ params: { activeCap: 1 } });
    expect(result.status).toBe("completed");
    expect(result.demotedToAging).toBe(1);
    expect(result.narrativeWritten).toBe(false);
    expect(mocks.narratives).toHaveLength(0);
  });

  it("合并 LLM 输出为空时跳过该组，不算失败", async () => {
    mocks.l2Memories = [
      makeL2({ id: "ag1", status: "aging", ragId: "rag_ag1" }),
      makeL2({ id: "ag2", status: "aging", ragId: "rag_ag2" }),
      makeL2({ id: "ag3", status: "aging", ragId: "rag_ag3" }),
    ];
    mocks.ragEntries = [
      { id: "rag_ag1", embedding: [1, 0, 0] },
      { id: "rag_ag2", embedding: [0.99, 0.05, 0] },
      { id: "rag_ag3", embedding: [0.98, 0.1, 0] },
    ];
    mocks.llmResponses = [""];
    const result = await runDreamCycle();
    expect(result.status).toBe("completed");
    expect(result.mergedGroups).toBe(0);
    expect(mocks.mergeBatches).toHaveLength(0);
  });

  it("pinned/总结/冲突条目不进合并候选", async () => {
    mocks.l2Memories = [
      makeL2({ id: "ag1", status: "aging", ragId: "rag_ag1" }),
      makeL2({ id: "ag2", status: "aging", ragId: "rag_ag2", isPinned: true }),
      makeL2({ id: "ag3", status: "aging", ragId: "rag_ag3", isSummary: true }),
      makeL2({ id: "ag4", status: "aging", ragId: "rag_ag4", conflictWith: ["x"] }),
    ];
    mocks.ragEntries = [
      { id: "rag_ag1", embedding: [1, 0, 0] },
      { id: "rag_ag2", embedding: [1, 0, 0] },
      { id: "rag_ag3", embedding: [1, 0, 0] },
      { id: "rag_ag4", embedding: [1, 0, 0] },
    ];
    const result = await runDreamCycle();
    expect(result.status).toBe("completed");
    expect(result.mergedGroups).toBe(0); // 只剩 ag1 一条，凑不成组
    expect(mocks.capturedPrompts).toHaveLength(0);
  });
});

describe("调度器", () => {
  it("开关关闭时永不触发", async () => {
    vi.useFakeTimers();
    writeSettings({ memoryDreamEnabled: false });
    startDreamScheduler();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(mocks.enqueueCalls).toHaveLength(0);
  });

  it("空闲 ≥15 分钟后触发一次，24 小时冷却内不重复", async () => {
    vi.useFakeTimers();
    writeSettings({ memoryDreamEnabled: true, provider: "p", baseUrl: "b", model: "m", apiKey: "k" });
    startDreamScheduler();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 空闲 10 分钟 < 15
    expect(mocks.enqueueCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 空闲 20 分钟 → 做梦
    expect(mocks.enqueueCalls).toEqual(["MemoryDream"]);
    const state = loadDreamState();
    expect(state.lastDreamAt).toBeTypeOf("number");
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0].status).toBe("completed");

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1 小时后仍在冷却期
    expect(mocks.enqueueCalls).toHaveLength(1);
  });

  it("用户活动重置空闲窗口：回归后需重新攒满 15 分钟", async () => {
    vi.useFakeTimers();
    writeSettings({ memoryDreamEnabled: true, provider: "p", baseUrl: "b", model: "m", apiKey: "k" });
    startDreamScheduler();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    notifyDreamUserActivity();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 距上次活动仅 10 分钟
    expect(mocks.enqueueCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000); // 距上次活动 20 分钟 → 做梦
    expect(mocks.enqueueCalls).toEqual(["MemoryDream"]);
  });
});
