import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createRetrieval, rankLocalMemoryCandidates } from "../plugins/companion-memory/src/retrieval";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { memoryCandidate } from "./support/memory-candidate";

function fixture() {
  const map = new Map<string, any>();
  const storage: PluginStorage = { get: (k) => structuredClone(map.get(k)), set: (k, v) => { map.set(k, structuredClone(v)); }, rootDir: () => "unused" };
  const memory = createMemory(storage);
  memory.ingest({ id: "t", sessionId: "s", user: "我喜欢猫咪", assistant: "知道了", userAt: 1, assistantAt: 2 });
  const generate = vi.fn(async (_prompt: string, _signal: AbortSignal) => '["猫咪"]');
  const retrieval = createRetrieval(storage, (q, extra, ids, reranked, selected, maxChars) => memory.searchWithBudget(q, extra, ids, reranked, selected, maxChars), generate);
  return { retrieval, memory, generate, storage };
}
const signal = () => new AbortController().signal;
it("本地记忆候选顺序先补词面命中再统一重排，分面通道随后追加", async () => {
  const candidates = ["a", "b", "c", "kind"].map((id) => ({ id, text: id, embedding: [1], weight: 1, lastRecalledAt: 1 }));
  const rank = vi.fn(async (input: { mode?: string; candidates: typeof candidates }) => {
    if (input.mode === "lexical") return { rankedIds: ["c"], vectorHitIds: [], ranked: [{ id: "c", score: 2 }] };
    if (input.candidates.length === 1) return { rankedIds: ["kind"], vectorHitIds: ["kind"], ranked: [{ id: "kind", score: 0.2 }] };
    return { rankedIds: ["a", "b"], vectorHitIds: ["a"], ranked: [{ id: "a", score: 0.8 }, { id: "b", score: 0.7 }] };
  });
  const rerankDocuments = vi.fn(async ({ documents }: { documents: string[] }) => documents.map((text) => ({ text, score: text === "c" ? 1 : 0 })).sort((left, right) => right.score - left.score));
  const result = await rankLocalMemoryCandidates({ rank, rerankDocuments }, "query", candidates, 2, ["kind"], signal());
  expect(result.ids).toEqual(["c", "a", "kind"]);
  expect(result.vectorHitIds).toEqual(["a"]);
  expect(rank).toHaveBeenCalledWith(expect.objectContaining({ rawScore: true, rerank: false, topK: 2 }));
});
describe("可选查询扩展", () => {
  it("可选语义候选只决定现有记忆 ID，不把模型文本写入结果", async () => {
    const initial = fixture(), data = initial.storage, memory = initial.memory;
    for (let i = 0; i < 10; i++) memory.ingest({ id: `semantic-${i}`, sessionId: "semantic", user: `我喜欢第${i}种茶`, assistant: "收到", userAt: 10 + i, assistantAt: 20 + i });
    await memory.maintain(vi.fn().mockResolvedValue(JSON.stringify([memoryCandidate({
      layer: "L2", field: undefined, summary: "偏爱乌龙茶", sourceQuote: "我喜欢第0种茶", evidenceQuotes: ["我喜欢第0种茶"],
      facets: { primaryKind: "preference", retrievalKinds: ["preference"] },
    })])), signal());
    const id = memory.view().entries[0].id, semantic = vi.fn().mockResolvedValue([id]);
    const retrieval = createRetrieval(data, (q, extra, ids, reranked, selected, maxChars) => memory.searchWithBudget(q, extra, ids, reranked, selected, maxChars), vi.fn(), semantic);
    const before = memory.view(), result = await retrieval.search("完全不同的问法", signal());
    expect(result).toContain("偏爱乌龙茶"); expect(semantic).toHaveBeenCalledWith("完全不同的问法", expect.any(AbortSignal), undefined, expect.objectContaining({ scope: "normal", maxResults: 5 }));
    expect(memory.view()).toEqual(before);
  });
  it("结构化记忆检索不再夹带历史原文，历史由独立共享管线负责", () => {
    const { memory } = fixture();
    memory.ingest({ id: "t2", sessionId: "s", user: "讨论宠物", assistant: "好的", userAt: 3, assistantAt: 4 });
    const result = memory.search("宠物", ["猫咪"]);
    expect(result).toBe("");
    expect(result).not.toContain("历史");
  });
  it("默认不请求模型；启用后扩展词只参与结构化记忆检索，不回退扫描历史", async () => {
    const { retrieval, memory, generate, storage } = fixture();
    expect(await retrieval.search("宠物", signal())).toBe("");
    expect(generate).not.toHaveBeenCalled();
    retrieval.set(true);
    const before = memory.view();
    expect(await retrieval.search("宠物", signal())).toBe("");
    expect(generate.mock.calls[0][0]).not.toContain("我喜欢猫咪");
    expect(memory.view()).toEqual(before);
    expect(createRetrieval(storage, () => ({ text: "", includedMemoryIds: [] }), generate).view()).toBe(true);
  });
  it("空扩展仍执行结构化记忆检索，空查询不请求模型", async () => {
    const { retrieval, generate } = fixture(); retrieval.set(true);
    generate.mockResolvedValue("[]");
    expect(await retrieval.search("猫咪", signal())).toBe("");
    generate.mockClear(); expect(await retrieval.search(" ", signal())).toBe("");
    expect(generate).not.toHaveBeenCalled();
  });
  it.each(['not json', '[1]', '["a","b","c","d"]', '[""]', JSON.stringify(["x".repeat(81)])])("拒绝无效输出 %s", async (raw) => {
    const { retrieval, generate } = fixture(); retrieval.set(true); generate.mockResolvedValue(raw);
    await expect(retrieval.search("宠物", signal())).rejects.toThrow("查询扩展结果无效");
  });
  it("取消后的迟到结果不使用，服务错误不静默降级", async () => {
    const { retrieval, generate } = fixture(); retrieval.set(true);
    const controller = new AbortController();
    generate.mockImplementation(async () => { controller.abort(); return '["猫咪"]'; });
    await expect(retrieval.search("宠物", controller.signal)).rejects.toThrow("取消");
    generate.mockRejectedValue(new Error("服务不可用"));
    await expect(retrieval.search("宠物", signal())).rejects.toThrow("服务不可用");
  });
  it("原生 Prompt Provider 热路径不调用模型重排", async () => {
    const { storage, memory } = fixture(), rerank = vi.fn().mockResolvedValue([]), candidates = vi.fn().mockReturnValue([]);
    const retrieval = createRetrieval(storage, (query, expansions, semanticIds, rerankedIds, selectedIds, maxChars) => memory.searchWithBudget(query, expansions, semanticIds, rerankedIds, selectedIds, maxChars), vi.fn(), undefined, candidates, rerank);
    await retrieval.searchForPrompt("猫咪", signal());
    expect(candidates).not.toHaveBeenCalled(); expect(rerank).not.toHaveBeenCalled();
  });
  it("普通检索把候选交给重排器，并将返回顺序传入正式渲染", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: [] }), candidates = vi.fn().mockReturnValue([{ id: "a", content: "甲" }, { id: "b", content: "乙" }]), rerank = vi.fn().mockResolvedValue(["b", "a"]);
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, candidates, rerank);
    await expect(retrieval.search("查询", signal())).resolves.toBe("完成");
    expect(candidates).toHaveBeenCalledWith("查询", [], [], expect.objectContaining({ scope: "normal", maxResults: 5 }));
    expect(rerank).toHaveBeenCalledWith("查询", [{ id: "a", content: "甲" }, { id: "b", content: "乙" }], expect.any(AbortSignal));
    expect(render).toHaveBeenCalledWith("查询", [], [], ["b", "a"], undefined, expect.any(Number), undefined, undefined, expect.objectContaining({ scope: "normal", maxResults: 5 }));
  });
  it("只有实际聊天注入更新工作集，手动搜索保持只读", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: ["a"] }), base = vi.fn().mockReturnValue(["a"]), preview = vi.fn().mockReturnValue(["a", "resident"]), commit = vi.fn();
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined, base, preview, commit);
    await retrieval.search("查询", signal());
    expect(base).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    expect(render).toHaveBeenLastCalledWith("查询", [], [], [], undefined, expect.any(Number), undefined, undefined, expect.objectContaining({ scope: "normal", maxResults: 5 }));
    await retrieval.searchForChat("查询", signal());
    expect(preview).toHaveBeenCalledWith(["a"]);
    expect(render).toHaveBeenLastCalledWith("查询", [], [], [], ["a", "resident"], expect.any(Number), false, "automatic", expect.objectContaining({ scope: "normal", maxResults: 5 }));
    expect(commit).toHaveBeenLastCalledWith(["a"], ["a"]);
    preview.mockClear(); commit.mockClear(); await retrieval.searchForPrompt("查询", signal());
    expect(preview).toHaveBeenCalledWith(["a"]);
    expect(commit).toHaveBeenCalledWith(["a"], ["a"]);
    preview.mockClear(); commit.mockClear(); await retrieval.searchForPrompt("查询", signal(), false);
    expect(preview).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });
  it("宿主注入先生成只读回执，只有显式确认后才提交工作集", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: ["a"] }), preview = vi.fn().mockReturnValue(["a", "resident"]), commit = vi.fn();
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined, () => ["a"], preview, commit);
    await expect(retrieval.previewForPrompt("查询", signal(), 321)).resolves.toEqual({ text: "完成", includedMemoryIds: ["a"], recalledMemoryIds: ["a"] });
    expect(preview).toHaveBeenCalledWith(["a"]);
    expect(render).toHaveBeenCalledWith("查询", [], [], [], ["a", "resident"], 321, false, "automatic-related", expect.objectContaining({ scope: "normal", maxResults: 5 }));
    expect(commit).not.toHaveBeenCalled();
    retrieval.commitPromptReceipt({ includedMemoryIds: ["a", "a", "resident"], recalledMemoryIds: ["a", "a"] });
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(["a", "resident"], ["a"]);
  });
  it("回执区分真实查询命中与 DMAE 常驻补位", async () => {
    const data = fixture().storage;
    const render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: ["hit", "resident"] });
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined,
      () => ["hit"], () => ["hit", "resident"], vi.fn());
    await expect(retrieval.previewForPrompt("查询", signal())).resolves.toEqual({
      text: "完成", includedMemoryIds: ["hit", "resident"], recalledMemoryIds: ["hit"],
    });
  });
  it("Tool 显式查询不混入 DMAE 驻留补位、无独立字符截断并记录 L2 命中", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: ["m0"] });
    const base = vi.fn().mockReturnValue(Array.from({ length: 13 }, (_, index) => `m${index}`));
    const preview = vi.fn().mockReturnValue(Array.from({ length: 24 }, (_, index) => `m${index}`));
    const commit = vi.fn(), recordToolRecalls = vi.fn();
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined, base, preview, commit, undefined, undefined, recordToolRecalls);
    await expect(retrieval.searchForTool("查询", signal())).resolves.toBe("完成");
    expect(base).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith("查询", [], [], [], undefined, Number.MAX_SAFE_INTEGER, true, "tool", expect.objectContaining({ scope: "normal", maxResults: 5 }));
    expect(commit).not.toHaveBeenCalled();
    expect(recordToolRecalls).toHaveBeenCalledWith(["m0"]);
  });
  it("显式工具查询的召回统计写入失败不吞掉已找到的结果", async () => {
    const data = fixture().storage;
    const retrieval = createRetrieval(data, () => ({ text: "已找到", includedMemoryIds: ["m0"] }), vi.fn(),
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      () => { throw new Error("storage unavailable"); });
    await expect(retrieval.searchForTool("查询", signal())).resolves.toBe("已找到");
  });
  it("工具 topK 真正控制返回条数，最高十条且不会补足缺少的命中", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: [] });
    const retrieval = createRetrieval(data, render, vi.fn());
    const ids = Array.from({ length: 12 }, (_, index) => `m${index}`);
    await retrieval.searchForTool({ query: "查询", topK: 10 }, signal(), ids);
    expect(render).toHaveBeenCalledWith("查询", [], [], [], ids.slice(0, 10), Number.MAX_SAFE_INTEGER, true, "tool", expect.objectContaining({ maxResults: 5 }));
    await retrieval.searchForTool({ query: "查询", topK: 50 }, signal(), ids.slice(0, 2));
    expect(render).toHaveBeenLastCalledWith("查询", [], [], [], ids.slice(0, 2), Number.MAX_SAFE_INTEGER, true, "tool", expect.anything());
  });
  it("显式工具查询不受自动查询扩展与模型路由开关影响", async () => {
    const data = fixture().storage, generate = vi.fn().mockResolvedValue('["扩展词"]');
    data.set("query-expansion", true);
    const route = vi.fn().mockResolvedValue({ needsExpansion: true, retrievalKinds: ["preference"], confidence: 1 });
    const retrieval = createRetrieval(data, () => ({ text: "", includedMemoryIds: [] }), generate,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, route);
    await retrieval.searchForTool({ query: "乌龙茶", topK: 10 }, signal(), []);
    expect(generate).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });
  it("查询路由关闭时，清单措辞仍按本地默认 Top 5 处理", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: [] });
    const base = vi.fn().mockReturnValue(Array.from({ length: 20 }, (_, index) => `m${index}`));
    const preview = vi.fn().mockReturnValue(["resident"]), commit = vi.fn();
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined, base, preview, commit);
    await retrieval.searchForTool("列出我的所有偏好", signal());
    expect(preview).not.toHaveBeenCalled();
    expect(base).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith("列出我的所有偏好", [], [], [], undefined, Number.MAX_SAFE_INTEGER, true, "tool", expect.objectContaining({ scope: "normal", maxResults: 5 }));
    expect(commit).not.toHaveBeenCalled();
  });
  it("显式工具查询与本地 user_memory 一样不使用可选模型路由", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: [] });
    const route = vi.fn().mockResolvedValue({ needsExpansion: true, retrievalKinds: ["preference"], scope: "exhaustive_list", confidence: 0.9 });
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, route);
    await retrieval.searchForTool("列出我的所有偏好", signal());
    expect(route).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith("列出我的所有偏好", [], [], [], undefined, Number.MAX_SAFE_INTEGER, true, "tool", expect.objectContaining({ scope: "normal", maxResults: 5 }));
  });
  it("always-on 反思只进入实际聊天注入，不污染手动搜索", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "检索结果", includedMemoryIds: [] }), context = vi.fn().mockReturnValue("反思材料");
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined, () => [], (ids) => ids, vi.fn(), context);
    await expect(retrieval.search("查询", signal())).resolves.toBe("检索结果");
    expect(context).not.toHaveBeenCalled();
    await expect(retrieval.searchForChat("查询", signal())).resolves.toBe("检索结果\n\n反思材料");
    expect(context).toHaveBeenCalledTimes(1);
    await expect(retrieval.searchForPrompt("查询", signal(), false)).resolves.toBe("检索结果");
    expect(context).toHaveBeenCalledTimes(1);
  });
  it("主动检索单独拼接人物关系，以便排在文档之后；普通聊天仍自动注入", async () => {
    const data = fixture().storage;
    const render = vi.fn().mockReturnValue({ text: "相关记忆", includedMemoryIds: [] });
    const graph = vi.fn().mockReturnValue("【人物关系】\n小鹿");
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined,
      () => [], (ids) => ids, vi.fn(), graph);
    await expect(retrieval.searchForProactive("小鹿", signal())).resolves.toBe("相关记忆");
    expect(graph).not.toHaveBeenCalled();
    await expect(retrieval.searchForChat("小鹿", signal())).resolves.toBe("相关记忆\n\n【人物关系】\n小鹿");
    expect(graph).toHaveBeenCalledWith("小鹿");
  });
});
