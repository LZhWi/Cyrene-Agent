import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createReranker } from "../plugins/companion-memory/src/reranker";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";

function storage(initial?: unknown) {
  const map = new Map<string, unknown>();
  if (initial !== undefined) map.set("memory-state", initial);
  const value: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined, set: (key, data) => { map.set(key, structuredClone(data)); }, rootDir: () => "unused" };
  return { value, map };
}
const signal = () => new AbortController().signal;

describe("可选模型候选重排", () => {
  it("默认关闭；启用后只发送临时候选编号和摘要，不发送真实 ID", async () => {
    const data = storage(), generate = vi.fn().mockResolvedValue('["C2","C1"]');
    const reranker = createReranker(data.value, generate);
    const candidates = [{ id: "secret-id-1", content: "喜欢乌龙茶" }, { id: "secret-id-2", content: "计划去京都" }];
    expect(await reranker.rank("旅行目的地", candidates, signal())).toEqual(["secret-id-1", "secret-id-2"]);
    expect(generate).not.toHaveBeenCalled();
    reranker.set(true);
    expect(await reranker.rank("旅行目的地", candidates, signal())).toEqual(["secret-id-2", "secret-id-1"]);
    const prompt = generate.mock.calls[0][0];
    expect(prompt).toContain("旅行目的地"); expect(prompt).toContain("喜欢乌龙茶"); expect(prompt).toContain("计划去京都");
    expect(prompt).not.toContain("secret-id");
  });

  it.each(['not json', '["C1"]', '["C1","C1"]', '["C1","C3"]'])("无效重排结果 %s 不改变基础顺序并留下通用错误状态", async (raw) => {
    const data = storage(), reranker = createReranker(data.value, vi.fn().mockResolvedValue(raw)); reranker.set(true);
    await expect(reranker.rank("查询", [{ id: "a", content: "甲" }, { id: "b", content: "乙" }], signal())).resolves.toEqual(["a", "b"]);
    expect(reranker.view()).toMatchObject({ lastError: { kind: "invalid" } });
  });

  it("服务失败回退基础顺序且不保存错误正文，取消仍立即终止", async () => {
    const data = storage(), controller = new AbortController(), generate = vi.fn().mockRejectedValue(new Error("synthetic-secret"));
    const reranker = createReranker(data.value, generate); reranker.set(true);
    const candidates = [{ id: "a", content: "甲" }, { id: "b", content: "乙" }];
    await expect(reranker.rank("查询", candidates, signal())).resolves.toEqual(["a", "b"]);
    expect(reranker.view()).toMatchObject({ lastError: { kind: "request" } });
    expect(JSON.stringify(reranker.view())).not.toContain("synthetic-secret");
    controller.abort(); await expect(reranker.rank("查询", candidates, controller.signal)).rejects.toThrow("取消");
  });

  it("置顶候选不交给模型且始终在前，模型只重排非置顶候选", () => {
    const entries = [
      { id: "pinned", content: "深色界面", quote: "使用深色", sourceAt: 1, turnId: "t1", sessionId: "s", pinned: true, status: "active" as const },
      { id: "tea", content: "喜欢乌龙茶", quote: "常喝乌龙茶", sourceAt: 2, turnId: "t2", sessionId: "s", pinned: false, status: "active" as const },
      { id: "trip", content: "计划去京都", quote: "想去京都", sourceAt: 3, turnId: "t3", sessionId: "s", pinned: false, status: "active" as const },
    ];
    const data = storage({ version: 2, revision: 0, turns: [], processed: [], entries, evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [] });
    const memory = createMemory(data.value), candidates = memory.rerankCandidates("安排", [], ["tea", "trip"]);
    expect(candidates.map((item) => item.id)).toEqual(["tea", "trip"]);
    const result = memory.search("安排", [], ["tea", "trip"], ["trip", "tea"]);
    expect(result.indexOf("记忆 pinned")).toBeLessThan(result.indexOf("记忆 trip"));
    expect(result.indexOf("记忆 trip")).toBeLessThan(result.indexOf("记忆 tea"));
  });
});
