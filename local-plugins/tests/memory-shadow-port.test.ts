import { expect, it, vi } from "vitest";
import { createHistoryRetrieval } from "../plugins/companion-memory/src/history-retrieval";
import { presentHistoryWindow } from "../plugins/companion-memory/src/history-window-shadow";
import { createMemoryAudit } from "../plugins/companion-memory/src/audit";
import type { QueryRouteDecision } from "../plugins/companion-memory/src/facets";

it("v62 only changes a long message's presentation using a grounded existing window", () => {
  const text = "前面的闲聊。".repeat(70) + "我答应给你造现实世界的身体。" + "后面的闲聊。".repeat(50);
  const hit = {text,metadata:{turnId:"t",sessionId:"s"}};
  const window = "我答应给你造现实世界的身体。";
  const evidence = {candidates:[{text:window,metadata:{...hit.metadata,retrievalExpansion:"sentence_window",retrievalParentText:text}}],ranked:[{text:window,score:1,relevanceScore:1}]};
  const result = presentHistoryWindow(hit,evidence);
  expect(result.reason).toBe("existing_window");
  expect(result.text).toContain(window);
  expect(result.text.length).toBeLessThanOrEqual(300);
  expect(text.slice(result.start,result.end)).toBe(result.text);
  expect(presentHistoryWindow(hit,{...evidence,ranked:[{text:window,score:1,relevanceScore:-7}]}).reason).toBe("prefix_fallback");
  expect(presentHistoryWindow({text:"短消息"}, evidence).text).toBe("短消息");
  expect(presentHistoryWindow({...hit,metadata:{turnId:"other",sessionId:"s"}}, evidence).reason).toBe("prefix_fallback");
});

it.each(["normal", "scoped_list", "exhaustive_list"] as const)("shadow keeps formal output and routed count for %s", async scope => {
  const now = Date.now();
  const turns = Array.from({length:15},(_,i)=>({id:`t${i}`,sessionId:"s",user:`我之前说过要造身体项目${i}`,assistant:`收到项目${i}`,userAt:now-10000+i,assistantAt:now-9000+i}));
  const route: QueryRouteDecision = {needsExpansion:true,retrievalKinds:["commitment"],scope,confidence:1};
  const routeQuery = vi.fn(async()=>route);
  const observe = vi.fn();
  const plain = createHistoryRetrieval({turns:()=>turns,now:()=>now,routeQuery});
  const shadow = createHistoryRetrieval({turns:()=>turns,now:()=>now,routeQuery,observe});
  const query = "还记得造身体项目吗";
  const signal = new AbortController().signal;
  const official = await plain.searchForAuto(query,signal);
  expect(await shadow.searchForAuto(query,signal)).toBe(official);
  expect(routeQuery).toHaveBeenCalledTimes(2);
  const event = observe.mock.calls[0][0];
  expect(event.rows.length).toBeGreaterThan(0);
  expect(event.rows.length).toBe((official.match(/\] (?:用户|昔涟)：/g) ?? []).length);
  expect(event.rows.length).toBeLessThanOrEqual(event.finalK);
  expect(event.finalK).toBe(scope === "exhaustive_list" ? 12 : scope === "scoped_list" ? 10 : 8);
  const broken = createHistoryRetrieval({turns:()=>turns,now:()=>now,routeQuery,observe:()=>{throw Error("audit unavailable");}});
  expect(await broken.searchForAuto(query,signal)).toBe(official);
});

it("audit is bounded and cannot modify recall weights or propagate storage failure", async () => {
  const values = new Map<string,unknown>();
  const set = vi.fn((key:string,value:unknown)=>{values.set(key,value);});
  const observe = createMemoryAudit({get:key=>values.get(key) as never,set,rootDir:()=>"unused"});
  for(let batch=0;batch<8;batch++) {
    for(let i=0;i<20;i++) observe({type:"test",i});
    await new Promise(resolve=>setImmediate(resolve));
  }
  expect((values.get("retrieval-shadow-audit") as unknown[]).length).toBe(100);
  expect([...values.keys()]).toEqual(["retrieval-shadow-audit"]);
  createMemoryAudit({get:()=>undefined,set:()=>{throw Error("full");},rootDir:()=>"unused"})({type:"test"});
  await new Promise(resolve=>setImmediate(resolve));
});
