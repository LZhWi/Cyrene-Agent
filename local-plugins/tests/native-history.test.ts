import { describe, expect, it, vi } from "vitest";
import type { PluginConversationMessage } from "@playa0v0/cyrene-plugin-sdk";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { createNativeHistory } from "../plugins/companion-memory/src/native-history";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";

const signal = () => new AbortController().signal;
const entry = (id: string, triggerText: string) => ({
  id,
  content: `记忆 ${id}`,
  quote: triggerText,
  triggerText,
  sourceAt: 100,
  turnId: "",
  sessionId: "",
  pinned: false,
  status: "active" as const,
  provenance: "legacy-unverified" as const,
});

function setup(entries: ReturnType<typeof entry>[], sessions: Record<string, PluginConversationMessage[]>) {
  const getMessages = vi.fn(async ({ conversationId }: { conversationId: string }) => ({
    items: sessions[conversationId] ?? [],
    range: sessions[conversationId]?.length ? { fromMessageId: sessions[conversationId][0].id, throughMessageId: sessions[conversationId].at(-1)!.id } : {},
  }));
  const list = vi.fn()
    .mockResolvedValueOnce({ items: [{ id: "s1", title: "会话一", mode: "chat", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z" }], nextCursor: "next" })
    .mockResolvedValueOnce({ items: [{ id: "s2", title: "会话二", mode: "chat", createdAt: "2026-09-03T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z" }] });
  const ctx = createMockPluginContext({ deps: { conversations: { list, getMessages } } });
  ctx.storage.set("memory-state", { version: 2, revision: 0, turns: [], processed: [], entries, evidence: [], profiles: emptyProfiles(), profileChanges: [], entryReviews: [] });
  const memory = createMemory(ctx.storage);
  return { ctx, memory, history: createNativeHistory(ctx, memory), getMessages, list };
}

describe("原生历史来源绑定", () => {
  it("只读列出会话并分页，不读取消息正文", async () => {
    const { history, getMessages, list } = setup([], {});
    const result = await history.list(signal());
    expect(result.map((item) => item.id)).toEqual(["s1", "s2"]);
    expect(list).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: 100 });
    expect(list).toHaveBeenNthCalledWith(2, { cursor: "next", limit: 100 });
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("预检不写记忆；唯一用户原文可批量绑定消息 ID、时间和已核验证据", async () => {
    const session = [
      { id: "a0", role: "assistant" as const, text: "前文", at: "2026-09-01T00:00:00Z" },
      { id: "u1", role: "user" as const, text: "我一直很喜欢喝乌龙茶", at: "2026-09-01T00:01:00Z" },
      { id: "a1", role: "assistant" as const, text: "知道了", at: "2026-09-01T00:02:00Z" },
    ];
    const { history, memory } = setup([entry("m1", "喜欢喝乌龙茶")], { s1: session });
    const preview = await history.preview({ conversationIds: ["s1"] }, signal());
    expect(preview).toMatchObject({ unique: 1, counts: { exact: 1 } });
    expect(memory.view()).toMatchObject({ revision: 0, evidence: [] });

    const applied = await history.applyUnique({ previewId: preview.id }, signal());
    expect(applied.bound).toBe(1);
    const state = memory.view();
    expect(state.entries[0]).toMatchObject({ provenance: "verified", sessionId: "s1", turnId: "host-message:u1", quote: "我一直很喜欢喝乌龙茶", sourceAt: Date.parse("2026-09-01T00:01:00Z") });
    expect(state.evidence[0]).toMatchObject({ memoryId: "m1", conversationId: "s1", messageIds: ["u1"], provenance: "verified", contextBeforeSnippet: "前文", contextAfterSnippet: "知道了" });
  });

  it("来源预检和绑定只使用清洗后的助手上下文，不改会话读取结果或用户原文", async () => {
    const session = [
      { id: "a0", role: "assistant" as const, text: "前文<think>隐藏推理</think>可见", at: "2026-09-01T00:00:00Z" },
      { id: "u1", role: "user" as const, text: "我喜欢 <soul> 这个标签", at: "2026-09-01T00:01:00Z" },
      { id: "a1", role: "assistant" as const, text: "知道了<soul>内部设定</soul>", at: "2026-09-01T00:02:00Z" },
    ];
    const { history, memory } = setup([entry("m1", "我喜欢 <soul> 这个标签")], { s1: session });
    const preview = await history.preview({ conversationIds: ["s1"] }, signal());
    expect(preview.results[0].candidates[0]).toMatchObject({
      text: "我喜欢 <soul> 这个标签", before: "前文可见", after: "知道了",
    });
    expect(session[0].text).toContain("隐藏推理");
    expect(session[2].text).toContain("内部设定");
    await history.applyUnique({ previewId: preview.id }, signal());
    expect(memory.view().evidence[0]).toMatchObject({
      quoteSnippet: "我喜欢 <soul> 这个标签", contextBeforeSnippet: "前文可见", contextAfterSnippet: "知道了",
    });
  });

  it("相同原文保持歧义，只有用户明确选择后才绑定", async () => {
    const sessions = {
      s1: [{ id: "u1", role: "user" as const, text: "重复的触发片段", at: "2026-09-01T00:01:00Z" }],
      s2: [{ id: "u2", role: "user" as const, text: "这里也是重复的触发片段", at: "2026-09-02T00:01:00Z" }],
    };
    const { history, memory } = setup([entry("m1", "重复的触发片段")], sessions);
    const preview = await history.preview({ conversationIds: ["s1", "s2"] }, signal());
    expect(preview).toMatchObject({ unique: 0, counts: { ambiguous: 1 } });
    expect(preview.results[0].candidates).toHaveLength(2);
    expect(memory.view().entries[0].provenance).toBe("legacy-unverified");

    await history.applySelection({ previewId: preview.id, entryId: "m1", conversationId: "s2", messageId: "u2" }, signal());
    expect(memory.view().entries[0]).toMatchObject({ provenance: "verified", sessionId: "s2", turnId: "host-message:u2" });
  });

  it("歧义语义判断使用两次宿主模型复核，只返回推荐而不写来源", async () => {
    const sessions = {
      s1: [{ id: "u1", role: "user" as const, text: "重复的触发片段，谈的是茶", at: "2026-09-01T00:01:00Z" }],
      s2: [{ id: "u2", role: "user" as const, text: "重复的触发片段，谈的是当前项目", at: "2026-09-02T00:01:00Z" }],
    };
    const { history, memory, ctx } = setup([entry("m1", "重复的触发片段")], sessions);
    const generateText = vi.fn()
      .mockResolvedValueOnce('{"sourceRefs":["C2"],"confidence":0.9,"reason":"直接支持"}')
      .mockResolvedValueOnce('{"supported":true,"confidence":0.95,"reason":"完整支持"}');
    ctx.deps.llm = { generateText };
    const preview = await history.preview({ conversationIds: ["s1", "s2"] }, signal());
    const reviewed = await history.reviewAmbiguity({ previewId: preview.id, entryId: "m1" }, signal());
    expect(reviewed.recommended).toBe(true);
    expect(reviewed.preview.results[0].recommendation).toMatchObject({ conversationId: "s2", messageId: "u2", locateConfidence: 0.9, verifyConfidence: 0.95 });
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[0][1]).toMatchObject({ purpose: "memory-source-review", maxTokens: 4096, timeoutMs: 120000 });
    expect(memory.view()).toMatchObject({ revision: 0, evidence: [] });
    expect(memory.view().entries[0].provenance).toBe("legacy-unverified");
  });

  it("助手文本不能作为来源，历史变化后旧预检不能落库", async () => {
    const sessions = { s1: [
      { id: "a1", role: "assistant" as const, text: "只有助手提到秘密词", at: "2026-09-01T00:00:00Z" },
      { id: "u1", role: "user" as const, text: "稳定触发片段", at: "2026-09-01T00:01:00Z" },
    ] };
    const { history, memory, getMessages } = setup([entry("assistant-only", "秘密词"), entry("changed", "稳定触发片段")], sessions);
    const preview = await history.preview({ conversationIds: ["s1"] }, signal());
    expect(preview.results.find((item) => item.entryId === "assistant-only")?.method).toBe("no-match");
    getMessages.mockImplementation(async () => ({ items: [{ ...sessions.s1[1], text: "内容已经改变" }], range: { fromMessageId: "u1", throughMessageId: "u1" } }));
    await expect(history.applyUnique({ previewId: preview.id }, signal())).rejects.toThrow("没有可自动绑定");
    expect(memory.view()).toMatchObject({ revision: 0, evidence: [] });
  });
});
