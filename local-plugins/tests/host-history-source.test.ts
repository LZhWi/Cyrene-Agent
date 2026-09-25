import { describe, expect, it } from "vitest";
import type { PluginConversationsService, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createHostHistorySource } from "../plugins/companion-memory/src/host-history-source";
import { createHistoryRetrieval } from "../plugins/companion-memory/src/history-retrieval";

const signal = () => new AbortController().signal;
const now = Date.parse("2026-09-23T08:00:00Z");

describe("宿主旧会话只读检索", () => {
  it("只读取 Chat 历史分页，不摄取未完成的末尾用户消息", async () => {
    const messages = [
      { id: "u1", role: "user" as const, text: "旧蓝色丝带", at: new Date(now - 2000).toISOString(),
        images: [{ name: "旧照片.png", caption: "蓝色丝带系在摆件上" }] },
      { id: "a1", role: "assistant" as const, text: "我记住了旧蓝色丝带", at: new Date(now - 1000).toISOString() },
      { id: "u2", role: "user" as const, text: "还记得吗", at: new Date(now).toISOString() },
    ];
    const conversations = {
      list: async () => ({ items: [
        { id: "chat-1", mode: "chat", updatedAt: "2026-09-23T08:00:00Z" },
        { id: "work-1", mode: "work", updatedAt: "2026-09-23T08:00:00Z" },
      ] }),
      getMessages: async ({ cursor }: { cursor?: string }) => ({
        items: cursor ? messages.slice(2) : messages.slice(0, 2),
        nextCursor: cursor ? undefined : "page-2", range: {},
      }),
    } as unknown as PluginConversationsService;
    const host = createHostHistorySource(conversations);
    const rows = await host.snapshot(signal());
    expect(rows.map((row) => row.id)).toEqual(["u1", "a1"]);
    expect(rows[0].images).toEqual([{ name: "旧照片.png", caption: "蓝色丝带系在摆件上" }]);
    const retrieval = createHistoryRetrieval({ turns: () => [], hostMessages: host.snapshot, now: () => now });
    expect(await retrieval.searchForTool("旧蓝色丝带", signal())).toContain("用户：旧蓝色丝带");
    expect(await retrieval.searchForAuto("还记得旧蓝色丝带吗", signal())).toContain("昔涟：我记住了旧蓝色丝带");
  });

  it("消息更正和删除后不再返回旧正文，并清理持久化向量", async () => {
    const data = new Map<string, unknown>();
    const storage: PluginStorage = {
      get: <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
      set: (key, value) => { data.set(key, structuredClone(value)); },
      rootDir: () => "unused",
    };
    data.set("history-retrieval-vector-index", { version: 1, entries: {
      "deleted-turn:user": { text: "已删除的私有旧消息", embedding: [1] },
      "host-message:chat-1:u1:window:0": { text: "旧蓝色丝带窗", embedding: [1] },
    } });
    let text = "旧蓝色丝带";
    const messages = async () => text ? [{ id: "u1", sessionId: "chat-1", role: "user" as const, text, at: now - 1000 }] : [];
    const service = {
      embed: async (texts: string[]) => ({ vectors: texts.map(() => [1]), identity: { provider: "test", model: "test", dimensions: 1 } }),
      rank: async ({ candidates }: { candidates: Array<{ id: string }> }) => ({
        rankedIds: candidates.map((candidate) => candidate.id), vectorHitIds: [],
        ranked: candidates.map((candidate) => ({ id: candidate.id, score: 1, method: "hybrid" as const })),
      }),
    };
    const retrieval = createHistoryRetrieval({ turns: () => [], hostMessages: messages, storage, service, now: () => now });
    retrieval.invalidateHostMessages("chat-1", false, ["u1"]);
    expect(Object.keys((data.get("history-retrieval-vector-index") as { entries: Record<string, unknown> }).entries)).toEqual(["deleted-turn:user"]);
    expect(await retrieval.searchForTool("丝带", signal())).toContain("旧蓝色丝带");
    expect(Object.keys((data.get("history-retrieval-vector-index") as { entries: Record<string, unknown> }).entries))
      .not.toContain("deleted-turn:user");
    text = "改成绿色围巾";
    retrieval.invalidateHostMessages("chat-1", false, ["u1"]);
    expect(await retrieval.searchForTool("围巾", signal())).toContain("改成绿色围巾");
    expect(await retrieval.searchForTool("丝带", signal())).not.toContain("旧蓝色丝带");
    text = "";
    expect(await retrieval.searchForTool("围巾", signal())).not.toContain("改成绿色围巾");
    const vectors = data.get("history-retrieval-vector-index") as { entries: Record<string, unknown> };
    expect(Object.keys(vectors.entries)).toEqual([]);
  });
});
