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

  it("历史轮次也不能在预算边缘留下半条用户或助手内容", () => {
    const turn = {
      id: "history-1", sessionId: "synthetic", user: "用户问茶的来源", assistant: "助手答复茶的完整说明",
      userAt: 1, assistantAt: 2,
    };
    const { memory } = memoryFixture([], [turn]);
    const full = memory.searchWithBudget("茶", [], [], [], undefined, 24_000);

    expect(full.text).toContain("[历史 history-1；");
    expect(full.text).toContain(turn.assistant);
    expect(memory.searchWithBudget("茶", [], [], [], undefined, full.text.length - 1)).toEqual({
      text: "",
      includedMemoryIds: [],
    });
  });

  it("真实记忆占满预算时仍优先保留一条匹配的私有历史轮次", () => {
    const turn = {
      id: "recent", sessionId: "synthetic", user: "乌龙茶是我刚才说的偏好", assistant: "已记下乌龙茶偏好",
      userAt: 10, assistantAt: 11,
    };
    const entries = [entry("one", "乌龙茶相关旧记忆一"), entry("two", "乌龙茶相关旧记忆二")];
    const { memory } = memoryFixture(entries, [turn]);
    const historyLength = memoryFixture([], [turn]).memory.searchWithBudget("乌龙茶", [], [], [], undefined, 24_000).text.length;
    const firstLength = memoryFixture([entries[0]]).memory.searchWithBudget("乌龙茶", [], [], [], undefined, 24_000).text.length;
    const result = memory.searchWithBudget("乌龙茶", [], [], [], undefined, historyLength + 2 + firstLength);

    expect(result.text).toContain("[历史 recent；");
    expect(result.text).toContain(turn.user);
    expect(result.text).toContain("[记忆 one；");
    expect(result.text).not.toContain("[记忆 two；");
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
    const commit = vi.fn((ids: string[]) => { dmae.apply(ids, entries); lifecycle.record(ids, entries); });
    const retrieval = createRetrieval(data.value, render, vi.fn(), undefined, undefined, undefined,
      () => ["too-large", "included"], preview, commit);
    const budget = data.memory.searchWithBudget("茶", [], [], [], ["included"], 24_000).text.length;

    const result = await retrieval.searchForPrompt("茶", signal(), true, budget);

    expect(render).toHaveBeenCalledWith("茶", [], [], [], ["too-large", "included"], budget);
    expect(result).toContain("[记忆 included；");
    expect(result).not.toContain("[记忆 too-large；");
    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith(["included"]);
    expect((data.map.get("dmae-state") as any).states).toHaveProperty("included");
    expect((data.map.get("dmae-state") as any).states).not.toHaveProperty("too-large");
    expect((data.map.get("lifecycle-state") as any).recalls).toHaveProperty("included");
    expect((data.map.get("lifecycle-state") as any).recalls).not.toHaveProperty("too-large");
  });
});
