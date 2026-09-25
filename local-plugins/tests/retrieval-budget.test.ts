import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createDmae } from "../plugins/companion-memory/src/dmae";
import type { Entry } from "../plugins/companion-memory/src/entries";
import { createLifecycle } from "../plugins/companion-memory/src/lifecycle";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";
import { createRetrieval } from "../plugins/companion-memory/src/retrieval";

const signal = () => new AbortController().signal;

function storage(initial?: unknown) {
  const map = new Map<string, unknown>(initial === undefined ? [] : [["memory-state", initial]]);
  const value: PluginStorage = {
    get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    set: (key, data) => { map.set(key, structuredClone(data)); },
    rootDir: () => "unused",
  };
  return { map, value };
}

function memoryFixture(entries: Entry[], turns: unknown[] = []) {
  const data = storage({
    version: 2, revision: 0, turns, processed: [], entries, evidence: [],
    profiles: emptyProfiles(), profileChanges: [], entryReviews: [], compressionReviews: [], lifecycleChanges: [],
  });
  return { ...data, memory: createMemory(data.value) };
}

const entry = (id: string, content: string): Entry => ({
  id, content, quote: `原话-${id}`, sourceAt: 1, turnId: `turn-${id}`, sessionId: "synthetic",
  pinned: false, status: "active",
});

describe("完整记忆块预算", () => {
  it("恰好容纳两个完整记忆块及分隔符，少一字时不输出第二块片段", () => {
    const { memory } = memoryFixture([entry("first", "第一条茶偏好"), entry("second", "第二条茶偏好")]);
    const args: [string, string[], string[], string[]] = ["茶", [], [], []];
    const first = memory.searchWithBudget(...args, ["first"], 24_000);
    const second = memory.searchWithBudget(...args, ["second"], 24_000);
    const exact = first.text.length + 2 + second.text.length;

    expect(memory.searchWithBudget(...args, ["first", "second"], exact)).toEqual({
      text: `${first.text}\n\n${second.text}`,
      includedMemoryIds: ["first", "second"],
    });
    expect(memory.searchWithBudget(...args, ["first", "second"], exact - 1)).toEqual({
      text: first.text,
      includedMemoryIds: ["first"],
    });
  });

  it("超长高优先级块整体跳过，仍可使用余量输出后续完整块", () => {
    const long = entry("long", `茶-${"长".repeat(500)}`);
    const short = entry("short", "茶-简短完整证据");
    const { memory } = memoryFixture([long, short]);
    const shortOnly = memory.searchWithBudget("茶", [], [], [], ["short"], 24_000);
    const result = memory.searchWithBudget("茶", [], [], [], ["long", "short"], shortOnly.text.length);

    expect(result).toEqual(shortOnly);
    expect(result.text).not.toContain("[记忆 long；");
    expect(result.includedMemoryIds).toEqual(["short"]);
  });

  it("预算不足时先保留置顶条目，即使工作集候选把它排在普通命中之后", () => {
    const pinned = { ...entry("pinned", "茶-置顶事实"), pinned: true };
    const { memory } = memoryFixture([entry("ordinary", "茶-普通命中"), pinned]);
    const limit = memory.searchWithBudget("茶", [], [], [], ["pinned"], 24_000).text.length;
    const result = memory.searchWithBudget("茶", [], [], [], ["ordinary", "pinned"], limit);

    expect(result.includedMemoryIds).toEqual(["pinned"]);
    expect(result.text).not.toContain("[记忆 ordinary；");
  });

  it("L2 预算渲染不再混入历史轮次，历史由独立共享检索管线负责", () => {
    const turn = {
      id: "history-1", sessionId: "synthetic", user: "用户问茶的来源", assistant: "助手答复茶的完整说明",
      userAt: 1, assistantAt: 2,
    };
    const { memory } = memoryFixture([], [turn]);
    expect(memory.searchWithBudget("茶", [], [], [], undefined, 24_000)).toEqual({
      text: "",
      includedMemoryIds: [],
    });
  });

  it("L2 预算只由结构化记忆占用，不再为历史轮次预留空间", () => {
    const turn = {
      id: "recent", sessionId: "synthetic", user: "乌龙茶是我刚才说的偏好", assistant: "已记下乌龙茶偏好",
      userAt: 10, assistantAt: 11,
    };
    const entries = [entry("one", "乌龙茶相关旧记忆一"), entry("two", "乌龙茶相关旧记忆二")];
    const { memory } = memoryFixture(entries, [turn]);
    const firstLength = memoryFixture([entries[0]]).memory.searchWithBudget("乌龙茶", [], [], [], undefined, 24_000).text.length;
    const result = memory.searchWithBudget("乌龙茶", [], [], [], undefined, firstLength);

    expect(result.text).toContain("[记忆 one；");
    expect(result.text).not.toContain("[记忆 two；");
    expect(result.text).not.toContain(turn.user);
    expect(result.includedMemoryIds).toEqual(["one"]);
  });

  it("DMAE 和生命周期只把预算内实际输出的 ID 计为命中", async () => {
    const entries = [entry("too-large", `茶-${"长".repeat(500)}`), entry("included", "茶-短条")];
    const data = memoryFixture(entries);
    const dmae = createDmae(data.value), lifecycle = createLifecycle(data.value, () => 100_000);
    dmae.set(true); lifecycle.set(true);
    const render = vi.fn((query: string, expansions: string[], semanticIds: string[], rerankedIds: string[], selectedIds: string[] | undefined, maxChars: number) =>
      data.memory.searchWithBudget(query, expansions, semanticIds, rerankedIds, selectedIds, maxChars));
    const preview = vi.fn((ids: string[]) => dmae.preview(ids, entries).selectedIds);
    const commit = vi.fn((includedIds: string[], recalledIds: string[]) => { dmae.commit(recalledIds, includedIds, entries); lifecycle.record(recalledIds, entries); });
    const retrieval = createRetrieval(data.value, render, vi.fn(), undefined, undefined, undefined,
      () => ["too-large", "included"], preview, commit);
    const budget = data.memory.searchWithBudget("茶", [], [], [], ["included"], 24_000).text.length;

    const result = await retrieval.searchForPrompt("茶", signal(), true, budget);

    expect(render).toHaveBeenCalledWith("茶", [], [], [], ["too-large", "included"], budget, false, "automatic", expect.objectContaining({ scope: "normal", maxResults: 5 }));
    expect(result).toContain("[记忆 included；");
    expect(result).not.toContain("[记忆 too-large；");
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(["included"], ["included"]);
    expect((data.map.get("dmae-state") as any).states).toHaveProperty("included");
    expect((data.map.get("dmae-state") as any).states).not.toHaveProperty("too-large");
    expect((data.map.get("lifecycle-state") as any).recalls).toHaveProperty("included");
    expect((data.map.get("lifecycle-state") as any).recalls).not.toHaveProperty("too-large");
  });

  it("相关 L2 的预览不提前注入常驻画像、实体和 Dream 上下文", async () => {
    const entries = [entry("long", `茶-${"长".repeat(500)}`), entry("short", "茶-短条")];
    const data = memoryFixture(entries);
    const alwaysOn = "【用户画像】\n称呼：小涟\n\n【人物关系】\n· 小鹿（人物）\n\n[长期陪伴叙事]\n· 一段长期印象";
    const render = vi.fn((query: string, expansions: string[], semanticIds: string[], rerankedIds: string[], selectedIds: string[] | undefined, maxChars: number) =>
      data.memory.searchWithBudget(query, expansions, semanticIds, rerankedIds, selectedIds, maxChars, false, "automatic-related"));
    const retrieval = createRetrieval(data.value, render, vi.fn(), undefined, undefined, undefined,
      () => ["long", "short"], (ids) => ids, vi.fn(), () => alwaysOn);
    const shortText = data.memory.searchWithBudget("茶", [], [], [], ["short"], 24_000, false, "automatic").text;
    const budget = shortText.length + 2 + alwaysOn.length;

    const result = await retrieval.previewForPrompt("茶", signal(), budget);

    expect(render).toHaveBeenCalledWith("茶", [], [], [], ["long", "short"], budget, false, "automatic-related", expect.any(Object));
    expect(result.text).not.toContain(alwaysOn);
    expect(result.text).toBe("");
    expect(result.text).not.toContain("茶-长");
    expect(result.includedMemoryIds).toEqual([]);
  });
});
