// memory-dream.sim.test.ts — 用真实 memory.json + rag 向量库做梦境管线只读模拟
//
// 原则：真实数据只读——读进内存后全部变更落在拷贝上，绝不回写用户文件。
// LLM 用确定性 mock（沉淀=模板叙事；合并=拼接去重），跑的是真实聚类与真实评分。
// 真实数据不存在时（CI / 其他机器）自动跳过。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { L2Memory } from "./memory-types";

const USER_DATA = "C:/Users/ASUS/AppData/Roaming/live2d-cyrene";
const MEMORY_PATH = `${USER_DATA}/memory.json`;
const RAG_PATH = `${USER_DATA}/rag-data/memory-store.json`;
const DATA_EXISTS = fs.existsSync(MEMORY_PATH) && fs.existsSync(RAG_PATH);

interface RagEntryRaw {
  id: string;
  text: string;
  embedding: number[];
  source: string;
  weight: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

const mocks = vi.hoisted(() => ({
  dataDir: "",
  ragEntries: [] as Array<{ id: string; text: string; embedding: number[]; createdAt: number; weight: number; metadata?: Record<string, unknown> }>,
  l2Memories: [] as L2Memory[],
  capturedPrompts: [] as Array<Array<{ role: string; content: string }>>,
  narratives: [] as Array<{ id: string; createdAt: number; text: string }>,
  mergeBatches: [] as Array<{ ids: string[]; mergedIntoId: string }>,
  statusUpdates: [] as Array<{ ids: string[]; status: string }>,
  addedSummaries: [] as Array<{ id: string; content: string; subEntryIds?: string[] }>,
  deletedVectors: [] as string[],
  fetchCalls: 0,
}));

vi.mock("../runtime/runtime-paths", () => ({
  getUserDataDir: () => mocks.dataDir,
}));
vi.mock("../token-usage-store", () => ({ recordUsage: vi.fn() }));
vi.mock("../llm-queue", () => ({
  enqueueLLMTask: async (_name: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../orchestrator/vendors", () => ({
  getAdapterForConfig: () => ({
    buildRequest: (req: { messages: Array<{ role: string; content: string }> }) => {
      mocks.capturedPrompts.push(req.messages);
      return { url: "http://mock.local/chat", headers: {}, body: "{}" };
    },
    // 确定性回复：从 prompt 里的条目行生成，保证可复现
    parseResponse: () => {
      const last = mocks.capturedPrompts[mocks.capturedPrompts.length - 1];
      const userMsg = last.find((m) => m.role === "user")?.content ?? "";
      // 只取「印象条目：」之后的 bullet，避免把 prompt 指令行也算进去
      const bulletBlock = userMsg.split("印象条目：")[1] ?? userMsg;
      const bullets = bulletBlock.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).split("（当时的原话")[0]);
      if (userMsg.includes("沉淀")) {
        return { text: `这些正在淡出的印象沉淀下来：我曾记下 ${bullets.length} 段与你的日常，它们共同勾勒出这段陪伴的轮廓，我会以更凝练的方式继续记得。` };
      }
      return { text: `（模拟合并）${bullets.map((b) => b.slice(0, 30)).join("；")}`.slice(0, 100) };
    },
  }),
}));
vi.mock("./memory-store", () => ({
  memoryStore: {
    getAllL2: async () => mocks.l2Memories.map((m) => ({ ...m })),
    updateL2Status: async (ids: string[], status: string) => {
      mocks.statusUpdates.push({ ids, status });
      for (const m of mocks.l2Memories) if (ids.includes(m.id)) m.status = status as L2Memory["status"];
    },
    addL2Memory: async (input: { content: string; subEntryIds?: string[] }) => {
      const m = { id: `sum_${mocks.addedSummaries.length + 1}`, content: input.content, subEntryIds: input.subEntryIds };
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
  isUserMemoryVectorStoreReady: () => true,
  getEntriesBySource: (source: string) => (source === "user_memory" ? mocks.ragEntries : []),
  addL2MemoryVector: async (_text: string, l2Id: string) => `rag_${l2Id}`,
  deleteUserMemoryVectors: async (ids: string[]) => { mocks.deletedVectors.push(...ids); },
}));
vi.mock("./memory-trace", () => ({ appendMemoryTrace: vi.fn() }));

import { dreamSlimScore, runDreamCycle } from "./memory-dream";

describe.skipIf(!DATA_EXISTS)("真实数据梦境模拟（只读）", () => {
  let originalL2: L2Memory[] = [];

  beforeEach(() => {
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-dream-sim-"));
    fs.writeFileSync(
      path.join(mocks.dataDir, "model-settings.json"),
      JSON.stringify({ provider: "mock", baseUrl: "http://mock.local", model: "mock-1", apiKey: "k1" }),
      "utf8",
    );
    mocks.capturedPrompts = [];
    mocks.narratives = [];
    mocks.mergeBatches = [];
    mocks.statusUpdates = [];
    mocks.addedSummaries = [];
    mocks.deletedVectors = [];

    // ── 加载真实数据（只读）──
    const mem = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8")) as { l2: L2Memory[] };
    originalL2 = mem.l2;
    mocks.l2Memories = mem.l2.map((m) => ({ ...m }));
    const rag = JSON.parse(fs.readFileSync(RAG_PATH, "utf8")) as RagEntryRaw[];
    mocks.ragEntries = rag
      .filter((e) => e.source === "user_memory")
      .map((e) => ({ id: e.id, text: e.text, embedding: e.embedding, createdAt: e.createdAt, weight: e.weight, metadata: e.metadata }));
    // 只读模拟绝不允许真实网络请求：stub fetch 拦截所有调用并计数
    mocks.fetchCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      mocks.fetchCalls += 1;
      return { ok: true, json: async () => ({}) };
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("默认容量下不做任何改动（当前规模远低于水位线）", async () => {
    const result = await runDreamCycle();
    expect(result.status).toBe("completed");
    expect(result.demotedToAging).toBe(0);
    expect(result.demotedToArchived).toBe(0);
    expect(result.narrativeWritten).toBe(false);
    expect(mocks.capturedPrompts).toHaveLength(0); // 0 次 LLM 调用
    // 不变量：所有条目状态不变
    expect(mocks.l2Memories.every((m) => m.status === originalL2.find((o) => o.id === m.id)?.status)).toBe(true);
  });

  it("压低水位模拟满载：降级顺序、叙事与真实向量聚类全链路", async () => {
    const now = Date.now();
    // activeCap=20：56 条 active 强制降 36 条；观察评分排序是否合理
    const result = await runDreamCycle({ params: { activeCap: 20 } });

    expect(result.status).toBe("completed");
    expect(result.demotedToAging).toBe(36);
    expect(result.narrativeWritten).toBe(true);
    // 只读模拟：fetch 已被 stub 拦截（无真实网络请求）；
    // 调用次数 = 沉淀 1 次 + 每组合并 1 次，与预算一致
    expect(mocks.fetchCalls).toBe(1 + result.mergedGroups);

    // 不变量 1：降级的 36 条必然是全库评分最低的 36 条（纯函数可复核）
    const scored = originalL2
      .filter((m) => !m.isPinned)
      .map((m) => ({ id: m.id, score: dreamSlimScore(m, now) }))
      .sort((a, b) => a.score - b.score);
    const expectedDemoted = new Set(scored.slice(0, 36).map((s) => s.id));
    const actualDemoted = mocks.statusUpdates
      .filter((u) => u.status === "aging")
      .flatMap((u) => u.ids);
    expect(new Set(actualDemoted)).toEqual(expectedDemoted);

    // 不变量 2：叙事写入且长度在 sanitize 区间内
    expect(mocks.narratives).toHaveLength(1);
    const narrative = mocks.narratives[0].text;
    expect(narrative.length).toBeGreaterThanOrEqual(20);
    expect(narrative.length).toBeLessThanOrEqual(600);

    // 不变量 3：被合并的源条目全部处于 merged 状态且指向总结 id
    for (const batch of mocks.mergeBatches) {
      for (const id of batch.ids) {
        const m = mocks.l2Memories.find((x) => x.id === id);
        expect(m?.status).toBe("merged");
        expect(m?.mergedInto).toBe(batch.mergedIntoId);
      }
      const summary = mocks.addedSummaries.find((s) => s.id === batch.mergedIntoId);
      expect(summary).toBeTruthy();
      expect(summary?.content.length).toBeGreaterThanOrEqual(5);
    }

    // 不变量 4：合并只发生在 aging 层（含本轮降级者），active/pinned 原样
    const mergedSourceIds = new Set(mocks.mergeBatches.flatMap((b) => b.ids));
    for (const m of originalL2) {
      if (!mergedSourceIds.has(m.id) && m.status === "active") {
        const after = mocks.l2Memories.find((x) => x.id === m.id);
        expect(after?.status === "active" || after?.status === "aging").toBe(true);
      }
    }

    // 报告数据（供人工审阅，完整内容见测试输出）
    const report = {
      input: { l2Total: originalL2.length, active: originalL2.filter((m) => m.status === "active").length, ragEntries: mocks.ragEntries.length },
      params: { activeCap: 20 },
      demotedToAging: result.demotedToAging,
      demotedScoreRange: [scored[0].score.toFixed(4), scored[35].score.toFixed(4)],
      keptScoreRange: [scored[36].score.toFixed(4), scored[scored.length - 1].score.toFixed(4)],
      narrativeChars: narrative.length,
      narrativePreview: narrative,
      mergedGroups: result.mergedGroups,
      mergedEntries: result.mergedEntries,
      mergeGroupsDetail: mocks.mergeBatches.map((b, i) => ({
        group: i + 1,
        size: b.ids.length,
        summary: mocks.addedSummaries.find((s) => s.id === b.mergedIntoId)?.content,
        sources: b.ids.map((id) => mocks.l2Memories.find((x) => x.id === id)?.content?.slice(0, 40)),
      })),
      llmCalls: mocks.capturedPrompts.length,
      vectorsDeleted: mocks.deletedVectors.length,
    };
    console.log("[DreamSim] 报告:", JSON.stringify(report, null, 2));
  }, 60000);
});

