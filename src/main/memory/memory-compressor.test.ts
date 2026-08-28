// 反思（L0/L1 元认知更新）真实场景测试：
// - L1 更新按模型声明的 target 路由（含 currentProject），缺失时退回关键词启发式
// - 空回复 ≠ "无建议"：reflectionOk=false，补跑标记不落标
// - model-settings.json 损坏时静默降级要留 error 日志（否则 "missing api key" 对不上因果）
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dataDir: "",
  llmText: "[]",
  requests: [] as Array<{ messages: Array<{ role: string; content: string }> }>,
  l1Updates: [] as Array<{ field: string; value: string }>,
  reflectionLogs: [] as Array<{ type: string; summary: string }>,
}));

vi.mock("../runtime/runtime-paths", () => ({
  getUserDataDir: () => mocks.dataDir,
}));
vi.mock("./memory-store", () => ({
  memoryStore: {
    getL0: async () => ({ preferredName: "P宝" }),
    getL1: async () => ({ recentGoals: "", recentPreferences: "", currentProject: "", roundCount: 20 }),
    getAllL2: async () => [], // 压缩阶段跳过（条目不足），聚焦 Reflection
    upsertL0Field: vi.fn(async () => undefined),
    replaceL1Field: async (field: string, value: string) => {
      mocks.l1Updates.push({ field, value });
    },
    appendReflectionLog: async (entry: { type: string; summary: string }) => {
      mocks.reflectionLogs.push(entry);
    },
  },
}));
vi.mock("../rag/index", () => ({
  addL2MemoryVector: vi.fn(),
  deleteUserMemoryVectors: vi.fn(),
  getEntriesBySource: () => [],
}));
vi.mock("../rag/vectorstore", () => ({
  cosineSimilarity: () => 0,
  JsonVectorStore: class {},
}));
vi.mock("../orchestrator/vendors", () => ({
  getAdapterForConfig: () => ({
    buildRequest: (_req: unknown, _cfg: unknown) => ({ url: "http://mock.local/chat", headers: {}, body: "{}" }),
    parseResponse: () => ({ text: mocks.llmText }),
  }),
}));
vi.mock("../token-usage-store", () => ({
  recordUsage: vi.fn(),
}));

import { buildCompressionPrompt, parseCompressionDecision, runReflectionAndCompression } from "./memory-compressor";

function writeSettings(content: string): void {
  fs.writeFileSync(path.join(mocks.dataDir, "model-settings.json"), content, "utf8");
}

describe("MemoryCompressor reflection", () => {
  beforeEach(() => {
    mocks.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-compressor-"));
    mocks.llmText = "[]";
    mocks.requests.length = 0;
    mocks.l1Updates.length = 0;
    mocks.reflectionLogs.length = 0;
    writeSettings(JSON.stringify({ provider: "mock", baseUrl: "http://mock.local", model: "mock-1", apiKey: "k1" }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(mocks.dataDir, { recursive: true, force: true });
  });

  it("routes L1 updates by the model-declared target, including currentProject", async () => {
    // 真实场景：用户在推进 Minecraft 陪玩系统，反思应能更新 currentProject——
    // 旧启发式只有 recentGoals/recentPreferences 两条路，currentProject 永远碰不到。
    mocks.llmText = JSON.stringify([
      { layer: "L1", field: "currentProject", target: "currentProject", content: "Minecraft 陪玩系统收尾", confidence: 0.9 },
      { layer: "L1", field: "recentPreferences", target: "recentPreferences", content: "最近喜欢晚上散步", confidence: 0.8 },
    ]);

    await expect(runReflectionAndCompression()).resolves.toEqual({ reflectionOk: true });

    expect(mocks.l1Updates).toContainEqual({ field: "currentProject", value: "Minecraft 陪玩系统收尾" });
    expect(mocks.l1Updates).toContainEqual({ field: "recentPreferences", value: "最近喜欢晚上散步" });
  });

  it("falls back to the keyword heuristic when target is missing", async () => {
    mocks.llmText = JSON.stringify([
      { layer: "L1", field: "recentGoals", content: "打算下周完成毕设", confidence: 0.9 },
      { layer: "L1", field: "recentPreferences", content: "最近开始喝美式", confidence: 0.9 },
    ]);

    await runReflectionAndCompression();

    expect(mocks.l1Updates).toContainEqual({ field: "recentGoals", value: "打算下周完成毕设" });
    expect(mocks.l1Updates).toContainEqual({ field: "recentPreferences", value: "最近开始喝美式" });
  });

  it("treats an empty model reply as failure so the catch-up marker is not written", async () => {
    // 空 content = 预算耗尽/服务端异常，不是"无建议"；reflectionOk=false
    // 让补跑逻辑下次启动重试，避免 v1 标记"失败也落标、欠账永久不清"的覆辙。
    mocks.llmText = "";

    await expect(runReflectionAndCompression()).resolves.toEqual({ reflectionOk: false });
    expect(mocks.l1Updates).toHaveLength(0);
  });

  it("logs an error when model-settings.json is corrupted instead of failing silently", async () => {
    writeSettings("{corrupted json");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // 损坏配置 → 降级默认（无 apiKey）→ reflection 失败，但必须留下因果日志
    await expect(runReflectionAndCompression()).resolves.toEqual({ reflectionOk: false });

    expect(errorSpy).toHaveBeenCalledWith(
      "[MemoryCompressor] 读取 model-settings.json 失败，退回默认设置:",
      expect.anything(),
    );
    errorSpy.mockRestore();
  });
});

describe("MemoryCompressor timeline prompt", () => {
  it("anchors relative time to each source and requires plan-to-outcome reasoning", () => {
    const prompt = buildCompressionPrompt([
      { id: "plan", content: "用户明天玩剧本杀", triggerText: "我明天白天去玩", sourceConversationId: "", sourceAt: Date.parse("2026-08-22T18:16:00Z"), createdAt: Date.parse("2026-08-24T14:00:00Z"), lastAccessedAt: 0, accessCount: 0, weight: 0, isPinned: false, status: "active", facets: { primaryKind: "commitment", retrievalKinds: ["commitment"], source: "model", pendingClassification: false } },
      { id: "done", content: "用户玩剧本杀拿到大boss身份", triggerText: "我拿到了大boss", sourceConversationId: "", sourceAt: Date.parse("2026-08-23T15:59:00Z"), createdAt: Date.parse("2026-08-24T14:00:00Z"), lastAccessedAt: 0, accessCount: 0, weight: 0, isPinned: false, status: "active", facets: { primaryKind: "experience", retrievalKinds: ["experience"], source: "model", pendingClassification: false } },
    ])

    expect(prompt).toContain("2026-08-22T18:16:00.000Z")
    expect(prompt).toContain("类型：commitment")
    expect(prompt).toContain("类型：experience")
    expect(prompt).toContain("不得继续保留为未来待办")
  })

  it("accepts structured decisions and rejects plain summaries", () => {
    expect(parseCompressionDecision(JSON.stringify({ shouldCompress: true, summary: "用户已完成剧本杀活动", reason: "同一事件由计划推进到完成" }))).toEqual({
      shouldCompress: true,
      summary: "用户已完成剧本杀活动",
      reason: "同一事件由计划推进到完成",
    })
    expect(parseCompressionDecision("用户已完成剧本杀活动")).toBeNull()
  })
})
