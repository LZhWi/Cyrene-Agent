import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";
import { parseMemoryExtraction } from "../plugins/companion-memory/src/memory-extraction";
import { memoryCandidate } from "./support/memory-candidate";

function fixture() {
  const turns = Array.from({ length: 8 }, (_, i) => ({ id: `t${i+1}`, sessionId: "s", user: `用户消息${i+1}`,
    assistant: "好的", userAt: 10+i*2, assistantAt: 11+i*2, origin: "host" as const,
    inputMessageId: `u${i+1}`, finalMessageId: `a${i+1}` }));
  turns[1].user = "我整理了文档，累了会找你聊天";
  turns[2].user = "我给文档加了中英文对照表";
  const entries = ["用户整理了文档", "用户累了会来聊天"].map((content,i)=>({
    id:`m${i+1}`,content,quote:turns[1].user,turnId:"t2",sessionId:"s",sourceAt:12,
    pinned:false,status:"active" as const,provenance:"verified" as const,
  }));
  const map = new Map<string,unknown>([["memory-state", { version:2,revision:0,turns,processed:["t1","t2"],entries,
    profiles:emptyProfiles() }]]);
  const storage: PluginStorage = { get:<T>(key:string)=>structuredClone(map.get(key)) as T,
    set:(key,value)=>{map.set(key,structuredClone(value));}, rootDir:()=>"unused" };
  return { memory:createMemory(storage), storage, turns };
}
const keep = (id:string) => ({memoryAction:"keep",targetMemoryId:id,reason:"未改变"});
const supplement = () => memoryCandidate({layer:"L2",memoryAction:"supplement",targetMemoryId:"m1",
  summary:"文档新增中英文对照表",evidenceQuotes:["我给文档加了中英文对照表"],evidenceTurnRefs:["T3"]});
const signal = () => new AbortController().signal;

describe("6/8 增量提取",()=>{
  it("replays derived-store cleanup after source turns are removed, including dependent summaries", () => {
    const { storage } = fixture();
    const state: any = storage.get("memory-state");
    state.entries.push({ ...state.entries[0], id: "summary", isSummary: true, subEntryIds: ["m1", "m2"] });
    storage.set("memory-state", state);
    const change = { conversationId: "s", allMessages: false, invalidatedMessageIds: ["a2"] };
    const first = createMemory(storage).invalidateHostSources(change);
    const restarted = createMemory(storage);
    const replay = restarted.invalidateHostSources(change);
    expect(new Set(replay.invalidatedEntryIds)).toEqual(new Set(["m1", "m2", "summary"]));
    expect(replay.invalidatedEntryIds).toEqual(first.invalidatedEntryIds);
    expect(restarted.view().entries.every(entry => entry.status === "archived")).toBe(true);
  });
  it("有依据的同义转述经一次复核后写入，并保留其他候选",async()=>{
    const {storage}=fixture();
    const state:any=storage.get("memory-state");
    state.turns[2].user="以后就不喝咖啡了";
    storage.set("memory-state",state);
    const memory=createMemory(storage);
    const candidate=memoryCandidate({layer:"L2",summary:"用户不再喝咖啡",evidenceQuotes:[state.turns[2].user],evidenceTurnRefs:["T3"]});
    const generate=vi.fn(async(messages)=>{
      const second=messages.length>2;
      if(second) {
        expect(messages.at(-1).content).toContain("以后就不喝咖啡了");
        expect(messages.at(-1).content).toContain("用户不再喝咖啡");
      }
      return JSON.stringify([keep("m1"),keep("m2"),{...candidate,...(second?{reason:"语义复核通过：以后就不喝了表示停止行为，不再与原文含义相同。"}:{})}]);
    });
    await memory.maintain(generate,signal());
    expect(generate).toHaveBeenCalledTimes(2);
    expect(memory.view().pending).toBe(0);
    expect(memory.view().entries).toHaveLength(3);
  });
  it("否定丢失即使两边都有一定也需复核，未解决不消费批次",async()=>{
    const {storage}=fixture();
    const state:any=storage.get("memory-state");
    state.turns[2].user="我不一定喜欢咖啡";
    storage.set("memory-state",state);
    const memory=createMemory(storage);
    const generate=vi.fn(async()=>JSON.stringify([keep("m1"),keep("m2"),memoryCandidate({layer:"L2",summary:"用户一定喜欢咖啡",
      evidenceQuotes:[state.turns[2].user],evidenceTurnRefs:["T3"]})]));
    await expect(memory.maintain(generate,signal())).rejects.toThrow("需要语义复核");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(memory.view().pending).toBe(6);
    expect(memory.view().entries).toHaveLength(2);
  });
  it("提供同一来源的两个独立旧事实，追加补充并保留来源和审计，重启不重复处理",async()=>{
    const {memory,storage}=fixture();
    const generate=vi.fn(async messages=>{
      expect(messages[1].content).toContain('"id":"m1"');
      expect(messages[1].content).toContain('"id":"m2"');
      expect(messages[0].content).toContain("T1～T8");
      return JSON.stringify([supplement(),keep("m2")]);
    });
    await expect(memory.maintain(generate,signal())).resolves.toEqual({batches:1,pending:0});
    expect(memory.view().entries).toHaveLength(2);
    expect(memory.view().entries[0]).toMatchObject({content:"用户整理了文档\n补充：文档新增中英文对照表",
      sourceEvidence:[{turnId:"t2"},{turnId:"t3"}],incrementalChanges:[{previousContent:"用户整理了文档"}]});
    expect(memory.view().entries[1].content).toBe("用户累了会来聊天");
    await createMemory(storage).maintain(generate,signal());
    expect(generate).toHaveBeenCalledTimes(1);
    memory.invalidateHostSources({conversationId:"s",allMessages:false,invalidatedMessageIds:["a3"]});
    expect(memory.view().entries[0].status).toBe("archived");
    expect(memory.view().turns).toHaveLength(7);
    expect(memory.view().processed).toHaveLength(7);
  });
  it("缺失审阅或伪造证据最多修复一次，整批失败保留队列",async()=>{
    const {memory}=fixture();
    const generate=vi.fn(async()=>JSON.stringify([supplement()]));
    await expect(memory.maintain(generate,signal())).rejects.toThrow("未审阅全部");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(memory.view().pending).toBe(6);
    expect(memory.view().entries[0].content).toBe("用户整理了文档");
    const bad={...supplement(),evidenceQuotes:["伪造用户原话"]};
    await expect(memory.maintain(async()=>JSON.stringify([bad,keep("m2")]),signal())).rejects.toThrow("逐字");
  });
  it("一次修复能成功，不接受截断响应的局部候选",async()=>{
    const {memory}=fixture();
    const generate=vi.fn().mockResolvedValueOnce('[{"memoryAction":"keep"}').mockResolvedValueOnce(JSON.stringify([supplement(),keep("m2")]));
    await memory.maintain(generate,signal());
    expect(generate).toHaveBeenCalledTimes(2);
    expect(memory.view().pending).toBe(0);
  });
  it("生成期间旧目标变化阻止写入",async()=>{
    const {memory}=fixture();
    await expect(memory.maintain(async()=>{
      memory.invalidateHostSources({conversationId:"s",allMessages:false,invalidatedMessageIds:["a2"]});
      return JSON.stringify([supplement(),keep("m2")]);
    },signal())).rejects.toThrow("记忆已发生变化");
    expect(memory.view().entries[0].content).toBe("用户整理了文档");
  });
  it("生成后重新验证前置轮次，而非仅验证新增轮次",async()=>{
    const {memory,turns}=fixture();
    const validate=vi.fn().mockResolvedValueOnce(turns.map(t=>t.id)).mockResolvedValueOnce(turns.filter(t=>t.id!=="t2").map(t=>t.id));
    await expect(memory.maintain(async()=>JSON.stringify([supplement(),keep("m2")]),signal(),validate)).rejects.toThrow("前置来源已变化");
    expect(memory.view().pending).toBe(6);
  });
  it("再生成替换同一用户轮次，被取代或删除的回复不计入队列",()=>{
    const {memory,turns}=fixture();
    memory.ingest({...turns[1],id:"duplicate-event"});
    expect(memory.view().turns).toHaveLength(8);
    expect(memory.view().entries[0].status).toBe("active");
    memory.ingest({...turns[7],id:"new-t8",finalMessageId:"new-a8",assistant:"重新生成"});
    expect(memory.view().turns).toHaveLength(8);
    expect(memory.view().turns.some(t=>t.id==="t8")).toBe(false);
    memory.invalidateHostSources({conversationId:"s",allMessages:false,invalidatedMessageIds:["new-a8"]});
    expect(memory.view().turns).toHaveLength(7);
  });
  it("明确纠正只替换目标片段，其他内容保留",async()=>{
    const {storage}=fixture();
    const state:any=storage.get("memory-state");
    state.turns[2].user="更正，文档名称改为音乐笔记";
    storage.set("memory-state",state);
    const memory=createMemory(storage);
    await memory.maintain(async()=>JSON.stringify([memoryCandidate({layer:"L2",memoryAction:"correct",targetMemoryId:"m1",
      replaceText:"文档",summary:"音乐笔记",evidenceQuotes:[state.turns[2].user],evidenceTurnRefs:["T3"]}),keep("m2")]),signal());
    expect(memory.view().entries[0].content).toBe("用户整理了音乐笔记");
  });
  it("未明确纠正不能替换旧内容，未知目标和临时编号均拒绝",async()=>{
    const {memory}=fixture();
    const correction={...supplement(),memoryAction:"correct",replaceText:"文档"};
    await expect(memory.maintain(async()=>JSON.stringify([correction,keep("m2")]),signal())).rejects.toThrow("纠正");
    expect(memory.view().entries[0].content).toBe("用户整理了文档");
    expect(()=>parseMemoryExtraction(JSON.stringify([keep("unknown")]),8,[{id:"m1"}])).toThrow("目标");
    expect(()=>parseMemoryExtraction(JSON.stringify([{...supplement(),summary:"T3新增对照表"},keep("m2")]),8,[{id:"m1"},{id:"m2"}])).toThrow("临时");
  });
});

it.each([
  ["眼前景色只是梦境","眼前景色在梦里面",true],
  ["用户只喝茶","用户喝茶",true],
  ["用户只喝茶","用户只是喜欢喝茶",true],
  ["用户永远喝茶","用户喝茶",true],
  ["用户只喝茶","用户只喝茶",true],
])("格式解析不以绝对化词直接过滤 %s",(summary,quote,accepted)=>{
  expect(parseMemoryExtraction(JSON.stringify([memoryCandidate({summary,evidenceQuotes:[quote]})]),1).length).toBe(accepted?1:0);
});
