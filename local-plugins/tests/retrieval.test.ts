import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createRetrieval } from "../plugins/companion-memory/src/retrieval";
import { createMemory } from "../plugins/companion-memory/src/memory";

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
describe("可选查询扩展", () => {
  it("可选语义候选只决定现有记忆 ID，不把模型文本写入结果", async () => {
    const initial = fixture(), data = initial.storage, memory = initial.memory;
    for (let i = 0; i < 10; i++) memory.ingest({ id: `semantic-${i}`, sessionId: "semantic", user: `我喜欢第${i}种茶`, assistant: "收到", userAt: 10 + i, assistantAt: 20 + i });
    await memory.maintain(vi.fn().mockResolvedValue('[{"content":"偏爱乌龙茶","quote":"我喜欢第0种茶","turnId":"semantic-0"}]'), signal());
    const id = memory.view().entries[0].id, semantic = vi.fn().mockResolvedValue([id]);
    const retrieval = createRetrieval(data, (q, extra, ids, reranked, selected, maxChars) => memory.searchWithBudget(q, extra, ids, reranked, selected, maxChars), vi.fn(), semantic);
    const before = memory.view(), result = await retrieval.search("完全不同的问法", signal());
    expect(result).toContain("偏爱乌龙茶"); expect(semantic).toHaveBeenCalledWith("完全不同的问法", expect.any(AbortSignal));
    expect(memory.view()).toEqual(before);
  });
  it("同等词数下优先原查询，返回来源而非扩展词生成的事实", () => {
    const { memory } = fixture();
    memory.ingest({ id: "t2", sessionId: "s", user: "讨论宠物", assistant: "好的", userAt: 3, assistantAt: 4 });
    const result = memory.search("宠物", ["猫咪"]);
    expect(result.indexOf("历史 t2")).toBeLessThan(result.indexOf("历史 t；"));
    expect(result).toContain("助手（非用户事实）");
  });
  it("默认不请求模型；启用后同义表达召回原文且不写入扩展词", async () => {
    const { retrieval, memory, generate, storage } = fixture();
    expect(await retrieval.search("宠物", signal())).toBe("");
    expect(generate).not.toHaveBeenCalled();
    retrieval.set(true);
    const before = memory.view();
    expect(await retrieval.search("宠物", signal())).toContain("我喜欢猫咪");
    expect(generate.mock.calls[0][0]).not.toContain("我喜欢猫咪");
    expect(memory.view()).toEqual(before);
    expect(createRetrieval(storage, () => ({ text: "", includedMemoryIds: [] }), generate).view()).toBe(true);
  });
  it("空扩展仍检索原查询，空查询不请求模型", async () => {
    const { retrieval, generate } = fixture(); retrieval.set(true);
    generate.mockResolvedValue("[]");
    expect(await retrieval.search("猫咪", signal())).toContain("我喜欢猫咪");
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
    expect(candidates).toHaveBeenCalledWith("查询", [], []);
    expect(rerank).toHaveBeenCalledWith("查询", [{ id: "a", content: "甲" }, { id: "b", content: "乙" }], expect.any(AbortSignal));
    expect(render).toHaveBeenCalledWith("查询", [], [], ["b", "a"], undefined, expect.any(Number));
  });
  it("只有实际聊天注入更新工作集，手动搜索保持只读", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: ["a"] }), base = vi.fn().mockReturnValue(["a"]), preview = vi.fn().mockReturnValue(["a", "resident"]), commit = vi.fn();
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined, base, preview, commit);
    await retrieval.search("查询", signal());
    expect(base).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    expect(render).toHaveBeenLastCalledWith("查询", [], [], [], undefined, expect.any(Number));
    await retrieval.searchForChat("查询", signal());
    expect(preview).toHaveBeenCalledWith(["a"]);
    expect(render).toHaveBeenLastCalledWith("查询", [], [], [], ["a", "resident"], expect.any(Number));
    expect(commit).toHaveBeenLastCalledWith(["a"]);
    preview.mockClear(); commit.mockClear(); await retrieval.searchForPrompt("查询", signal());
    expect(preview).toHaveBeenCalledWith(["a"]);
    expect(commit).toHaveBeenCalledWith(["a"]);
    preview.mockClear(); commit.mockClear(); await retrieval.searchForPrompt("查询", signal(), false);
    expect(preview).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
  });
  it("宿主注入先生成只读回执，只有显式确认后才提交工作集", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: ["a"] }), preview = vi.fn().mockReturnValue(["a", "resident"]), commit = vi.fn();
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined, () => ["a"], preview, commit);
    await expect(retrieval.previewForPrompt("查询", signal(), 321)).resolves.toEqual({ text: "完成", includedMemoryIds: ["a"] });
    expect(preview).toHaveBeenCalledWith(["a"]);
    expect(render).toHaveBeenCalledWith("查询", [], [], [], ["a", "resident"], 321);
    expect(commit).not.toHaveBeenCalled();
    retrieval.commitPromptReceipt(["a", "a"]);
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(["a"]);
  });
  it("Tool 阶段普通查询复现本地 Top5 + DMAE 最多 10 条并保留 6000 字硬保护", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: ["m0"] });
    const base = vi.fn().mockReturnValue(Array.from({ length: 13 }, (_, index) => `m${index}`));
    const preview = vi.fn().mockReturnValue(Array.from({ length: 24 }, (_, index) => `m${index}`));
    const commit = vi.fn();
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined, base, preview, commit);
    await expect(retrieval.searchForTool("查询", signal())).resolves.toBe("完成");
    expect(base).toHaveBeenCalledWith("查询", [], [], []);
    expect(render).toHaveBeenCalledWith("查询", [], [], [], Array.from({ length: 10 }, (_, index) => `m${index}`), 6_000);
    expect(commit).not.toHaveBeenCalled();
  });
  it("Tool 阶段清单查询保留扩大检索集，不混入 DMAE 驻留补位", async () => {
    const data = fixture().storage, render = vi.fn().mockReturnValue({ text: "完成", includedMemoryIds: [] });
    const base = vi.fn().mockReturnValue(Array.from({ length: 20 }, (_, index) => `m${index}`));
    const preview = vi.fn().mockReturnValue(["resident"]), commit = vi.fn();
    const retrieval = createRetrieval(data, render, vi.fn(), undefined, undefined, undefined, base, preview, commit);
    await retrieval.searchForTool("列出我的所有偏好", signal());
    expect(preview).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledWith("列出我的所有偏好", [], [], [], Array.from({ length: 20 }, (_, index) => `m${index}`), 6_000);
    expect(commit).not.toHaveBeenCalled();
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
});
