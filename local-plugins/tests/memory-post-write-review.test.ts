import { it, expect, vi } from "vitest";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { memoryCandidate } from "./support/memory-candidate";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
function fixture() {
 const map = new Map<string, unknown>();
 const storage: PluginStorage = { get: <T>(key: string) => structuredClone(map.get(key)) as T, set: (k,v) => { map.set(k, structuredClone(v)); }, rootDir: () => "unused" };
 const memory = createMemory(storage);
 for(let i=0;i<6;i++) memory.ingest({id:"t"+i,sessionId:"s",user:i===0?"以后就不喝咖啡了":"普通消息"+i,assistant:"收到",userAt:1,assistantAt:2});
 return {memory,storage};
}
async function extract() {
 const f=fixture(); const generate=vi.fn(async()=>JSON.stringify([memoryCandidate({layer:"L2",field:undefined,summary:"用户不再喝咖啡",evidenceQuotes:["以后就不喝咖啡了"],facets:{primaryKind:"preference",retrievalKinds:["preference"]}})]));
 await f.memory.maintain(generate,new AbortController().signal);
 return {...f,generate};
}
it("writes once and restores advisory review after restart",async()=>{
 const {memory,storage,generate}=await extract();expect(generate).toHaveBeenCalledTimes(1);expect(memory.view().processed).toHaveLength(6);
 const restarted=createMemory(storage);expect(restarted.view().semanticReviews).toHaveLength(1);expect(restarted.view().entries).toHaveLength(1);
});
it.each(["keep","edit","delete"])("resolves post-write review: %s",async action=>{
 const {memory,storage}=await extract(),review=memory.view().semanticReviews[0];
 memory.resolveSemanticReview({id:review.id,expectedContent:review.content,action,content:"用户计划停止喝咖啡"});
 const state=createMemory(storage).view();expect(state.semanticReviews).toEqual([]);expect(state.entries).toHaveLength(action==="delete"?0:1);
 if(action==="edit")expect(state.entries[0].content).toBe("用户计划停止喝咖啡");
});
it("rejects stale review",async()=>{
 const {memory}=await extract(),review=memory.view().semanticReviews[0],entry=memory.view().entries[0];
 memory.editEntry({...entry,content:"用户已经改喝茶",revision:memory.view().revision});
 expect(()=>memory.resolveSemanticReview({id:review.id,expectedContent:review.content,action:"delete"})).toThrow();expect(memory.view().entries[0].content).toBe("用户已经改喝茶");
});
it("invented evidence still blocks write",async()=>{
 const {memory}=fixture();await expect(memory.maintain(async()=>JSON.stringify([memoryCandidate()]),new AbortController().signal)).rejects.toThrow();expect(memory.view().processed).toEqual([]);
});
it("profile review targets the written field when two fields contain the same text",async()=>{
 const {memory}=fixture();memory.editProfile({layer:"L0",field:"preferredName",content:"用户不再喝咖啡",revision:memory.view().revision});
 await memory.maintain(async()=>JSON.stringify([memoryCandidate({layer:"L0",field:"permanentNote",summary:"用户不再喝咖啡",evidenceQuotes:["以后就不喝咖啡了"]})]),new AbortController().signal);
 expect(memory.view().semanticReviews[0].target).toBe("permanentNote");
});
