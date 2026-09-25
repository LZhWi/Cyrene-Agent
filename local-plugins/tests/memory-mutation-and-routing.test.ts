import { describe, expect, it, vi } from "vitest";
import { createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { createEntityGraph } from "../plugins/companion-memory/src/entity-graph";
import { createQueryRouter } from "../plugins/companion-memory/src/query-router";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";
import { memoryCandidate } from "./support/memory-candidate";

function storageFixture(seed?: Record<string, unknown>) {
  const map = new Map<string, unknown>(Object.entries(seed ?? {}));
  const storage: PluginStorage = {
    get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    set: (key, value) => { map.set(key, structuredClone(value)); },
    rootDir: () => "unused",
  };
  return { map, storage };
}

const entry = {
  id: "memory-1", content: "用户喜欢乌龙茶", quote: "我喜欢乌龙茶", sourceAt: 10,
  turnId: "host-turn-1", sessionId: "conversation-1", pinned: false, status: "active" as const,
};

function memoryState() {
  return {
    version: 2, revision: 0,
    turns: [{
      id: "host-turn-1", sessionId: "conversation-1", user: "我喜欢乌龙茶", assistant: "记住了",
      userAt: 10, assistantAt: 11, inputMessageId: "user-1", finalMessageId: "model-1", origin: "host",
    }],
    processed: ["host-turn-1"], entries: [entry],
    evidence: [{
      id: "evidence-1", memoryId: "memory-1", quoteSnippet: "我喜欢乌龙茶", sourceStatus: "active",
      createdAt: 12, conversationId: "conversation-1", messageIds: ["user-1"], provenance: "verified",
    }],
    profiles: emptyProfiles(), profileChanges: [], entryReviews: [], compressionReviews: [], lifecycleChanges: [], conflictChanges: [],
  };
}

describe("宿主消息变更与插件记忆失效同步", () => {
  it("删除原始消息会移除待提取轮次、归档直接记忆并把证据标为 deleted", () => {
    const { storage, map } = storageFixture({ "memory-state": memoryState() });
    const memory = createMemory(storage);
    const result = memory.invalidateHostSources({ conversationId: "conversation-1", allMessages: false, invalidatedMessageIds: ["user-1", "model-1"] });
    expect(result).toEqual({ changed: true, invalidatedTurnIds: ["host-turn-1"], invalidatedEntryIds: ["memory-1"] });
    expect(memory.view().turns).toEqual([]);
    expect(memory.view().entries[0]).toMatchObject({ id: "memory-1", status: "archived" });
    expect(memory.view().evidence[0]).toMatchObject({ id: "evidence-1", sourceStatus: "deleted" });
    expect(map.get("memory-trace")).toEqual(expect.arrayContaining([
      expect.objectContaining({ changes: expect.arrayContaining(["entries", "turns", "evidence"]), entryIds: ["memory-1"], turnIds: ["host-turn-1"] }),
    ]));
  });

  it("永久删除同时删除证据并清理其他条目的冲突引用", () => {
    const seeded: any = memoryState();
    seeded.entries.push({ ...entry, id: "memory-2", content: "另一条", conflictWith: ["memory-1"] });
    const { storage } = storageFixture({ "memory-state": seeded });
    const memory = createMemory(storage);
    const result = memory.deleteEntry({ id: "memory-1", revision: 0 });
    expect(result.deletedId).toBe("memory-1");
    expect(memory.view().entries).toEqual([expect.not.objectContaining({ conflictWith: expect.anything() })]);
    expect(memory.view().evidence).toEqual([]);
  });
});

describe("实体图谱与查询路由", () => {
  it("新回合立即从用户和助手正文提取实体，重复摄取不重复计数", () => {
    const { storage, map } = storageFixture();
    const graph = createEntityGraph(storage, () => 100);
    const memory = createMemory(storage, (turn) => {
      graph.ingest([turn.user]);
      graph.ingest([turn.assistant]);
    });
    const turn = { id: "t1", sessionId: "s", user: "小鹿是我的朋友", assistant: "我认识阿兰", userAt: 1, assistantAt: 2 };
    memory.ingest(turn);
    memory.ingest(turn);
    expect(graph.view()).toEqual({ count: 2 });
    expect((map.get("entity-graph") as { entities: Array<{ mentionCount: number }> }).entities.map((item) => item.mentionCount)).toEqual([1, 1]);
  });

  it("实体提取结果写入插件私有图谱并参与查询上下文", async () => {
    const { storage } = storageFixture();
    const memory = createMemory(storage), graph = createEntityGraph(storage, () => 100);
    for (let index = 0; index < 10; index++) memory.ingest({ id: `turn-${index}`, sessionId: "s", user: index === 0 ? "小鹿是我的朋友" : index === 1 ? "住在上海" : `普通消息${index}`, assistant: "收到", userAt: index + 1, assistantAt: index + 2 });
    await memory.maintain(async () => JSON.stringify([memoryCandidate({
      layer: "L2", field: undefined, summary: "小鹿是用户的朋友", sourceQuote: "小鹿是我的朋友",
      evidenceQuotes: ["小鹿是我的朋友"], facets: { primaryKind: "fact", retrievalKinds: ["fact"] },
    })]), new AbortController().signal, undefined, (texts) => graph.ingest(texts));
    expect(graph.view()).toEqual({ count: 2 });
    expect(graph.search("小鹿最近怎么样")).toContain("· 小鹿（人物）");
    expect(graph.search("去上海")).toContain("· 上海（地点）");
  });

  it("路由默认关闭；显式授权后仅把当前查询交给宿主路由服务", async () => {
    let key: string | undefined;
    const routeQuery = vi.fn(async () => ({ needsExpansion: true, retrievalKinds: ["preference" as const], scope: "scoped_list" as const, confidence: 0.9, source: "llm" as const }));
    const ctx = createMockPluginContext({ deps: {
      secrets: { get: async () => key, set: async (_name, value) => { key = value; }, delete: async () => false },
      memoryRetrieval: { embed: vi.fn(), rank: vi.fn(), routeQuery },
    } });
    const router = createQueryRouter(ctx);
    await expect(router.route("我的偏好", new AbortController().signal)).resolves.toMatchObject({ source: "fallback" });
    expect(routeQuery).not.toHaveBeenCalled();
    await router.save({ enabled: true, provider: "自定义", baseUrl: "http://127.0.0.1:11434/v1", model: "router", explicitTransport: "openai", reasoning: "off", apiKey: "local" });
    await expect(router.route("我的偏好", new AbortController().signal)).resolves.toMatchObject({ scope: "scoped_list", confidence: 0.9 });
    expect(routeQuery).toHaveBeenCalledWith(expect.objectContaining({ query: "我的偏好", apiKey: "local", model: "router", reasoning: "off" }));
  });
});
