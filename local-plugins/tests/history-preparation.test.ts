import { describe, expect, it, vi } from "vitest";
import type { PluginMemoryRetrievalService, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createHistoryRetrieval } from "../plugins/companion-memory/src/history-retrieval";

const identity = { provider: "test", model: "test", dimensions: 1 };
const messages = Array.from({ length: 40 }, (_, i) => ({ id: String(i), sessionId: "s", role: "user" as const,
  text: `之前买的蓝色丝带${i}`, at: Date.now() - 1000 }));
function fixture() {
  const data = new Map<string, any>();
  const storage: PluginStorage = { get: key => structuredClone(data.get(key)),
    set: (key, value) => { data.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const embed = vi.fn(async (texts: string[]) => { await pending; return { vectors: texts.map(() => [1]), identity }; });
  const rank = vi.fn<PluginMemoryRetrievalService["rank"]>(async ({ candidates, topK }) => ({
    rankedIds: candidates.slice(0, topK).map(x => x.id), vectorHitIds: [],
    ranked: candidates.slice(0, topK).map(x => ({ id: x.id, score: 1, method: "hybrid" as const })),
  }));
  const rerankDocuments = vi.fn(async ({ documents }: { documents: string[] }) => documents.map(text => ({ text, score: 1 })));
  const controller = new AbortController();
  const retrieval = createHistoryRetrieval({ turns: () => [], hostMessages: async () => messages,
    storage, service: { embed, rank, rerankDocuments } });
  return { data, storage, embed, rank, rerankDocuments, controller, retrieval, release };
}

describe("历史冷启动索引", () => {
  it("前台重排期间后台暂停后续批次，前台结束后续建", async () => {
    const f = fixture();
    let finish!: () => void;
    const busy = new Promise<void>(resolve => { finish = resolve; });
    f.rerankDocuments.mockImplementation(async ({ documents }) => { await busy; return documents.map(text => ({ text, score: 1 })); });
    const preparing = f.retrieval.prepare(f.controller.signal);
    await vi.waitFor(() => expect(f.embed).toHaveBeenCalledTimes(1));
    const querying = f.retrieval.searchForAuto("还记得蓝色丝带吗", new AbortController().signal);
    await vi.waitFor(() => expect(f.rerankDocuments).toHaveBeenCalled());
    f.release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.embed).toHaveBeenCalledTimes(1);
    finish(); await querying; await preparing;
    expect(f.embed).toHaveBeenCalledTimes(2);
  });

  it("后台嵌入未完成时首轮不等待，完整候选走词法和重排，完成后恢复混合与语义", async () => {
    const f = fixture();
    const preparing = f.retrieval.prepare(f.controller.signal);
    const first = await f.retrieval.searchForAuto("还记得之前蓝色丝带吗", new AbortController().signal);
    expect(first).toContain("蓝色丝带");
    expect(f.rank.mock.calls.every(([arg]) => arg.mode === "lexical" && arg.candidates.length === 40)).toBe(true);
    expect(f.rerankDocuments).toHaveBeenCalled();
    expect(f.data.has("history-retrieval-recall-state")).toBe(false);
    f.release(); await preparing;
    expect(Object.keys(f.data.get("history-retrieval-vector-index").entries)).toHaveLength(40);
    f.rank.mockClear();
    await f.retrieval.searchForAuto("还记得之前蓝色丝带吗", new AbortController().signal);
    expect(f.rank.mock.calls.some(([arg]) => arg.mode === "hybrid")).toBe(true);
    expect(f.rank.mock.calls.some(([arg]) => arg.mode === "semantic")).toBe(true);
    expect(f.embed).toHaveBeenCalledTimes(2);
  });

  it.each(["invalidate", "abort"])("%s 后在途向量不能落盘或创建召回状态", async action => {
    const f = fixture();
    const preparing = f.retrieval.prepare(f.controller.signal);
    await vi.waitFor(() => expect(f.embed).toHaveBeenCalled());
    if (action === "invalidate") f.retrieval.invalidateHostMessages("s", true, []);
    else f.controller.abort();
    f.release();
    await expect(preparing).rejects.toThrow();
    expect(f.data.has("history-retrieval-vector-index")).toBe(false);
    expect(f.data.has("history-retrieval-recall-state")).toBe(false);
  });

  it("中断后保留已完成批次，重启只计算剩余记录", async () => {
    const f = fixture();
    f.embed.mockImplementationOnce(async texts => ({ vectors: texts.map(() => [1]), identity }));
    const preparing = f.retrieval.prepare(f.controller.signal);
    await vi.waitFor(() => expect(f.embed).toHaveBeenCalledTimes(2));
    expect(Object.keys(f.data.get("history-retrieval-vector-index").entries)).toHaveLength(32);
    f.controller.abort(); f.release(); await expect(preparing).rejects.toThrow();
    const embed = vi.fn(async (texts: string[]) => ({ vectors: texts.map(() => [1]), identity }));
    const restarted = createHistoryRetrieval({ turns: () => [], hostMessages: async () => messages,
      storage: f.storage, service: { embed, rank: f.rank } });
    await restarted.prepare(new AbortController().signal);
    expect(embed.mock.calls[0][0]).toHaveLength(8);
    expect(Object.keys(f.data.get("history-retrieval-vector-index").entries)).toHaveLength(40);
  });
});

it("首轮补齐一个批次内的缺口，不因后台时序切换为词法", async () => {
 const f = fixture();
 const entries = Object.fromEntries(messages.slice(0,32).map(m=>['host-message:s:'+m.id,{text:m.text,embedding:[1]}]));
 f.data.set('history-retrieval-vector-index',{version:1,entries});
 const retrieval = createHistoryRetrieval({turns:()=>[],hostMessages:async()=>messages,storage:f.storage,service:{embed:f.embed,rank:f.rank,rerankDocuments:f.rerankDocuments}});
 f.release();
 const preparing=retrieval.prepare(f.controller.signal);
 await retrieval.searchForAuto('还记得蓝色丝带吗',f.controller.signal);await preparing;
 expect(f.rank.mock.calls.some(([arg])=>arg.mode==='lexical')).toBe(false);
 expect(Object.keys(f.data.get('history-retrieval-vector-index').entries)).toHaveLength(40);
});
