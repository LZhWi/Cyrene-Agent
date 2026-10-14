import { describe, expect, it, vi } from "vitest";
import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { createMaintenanceCycles } from "../plugins/companion-memory/src/maintenance-cycles";
import type { HostHistoryMessage } from "../plugins/companion-memory/src/host-history-source";
function fixture(initial=19, saved=new Map<string,unknown>()) {
  const messages: HostHistoryMessage[]=[];
  const add=(n:number)=>messages.push({id:`u${n}`,sessionId:"c",role:"user",text:`q${n}`,at:n},{id:`a${n}`,sessionId:"c",role:"assistant",text:`a${n}`,at:n});
  for(let i=1;i<=initial;i++)add(i);
  const listeners=new Map<string,Set<(e:any)=>any>>();
  const events:PluginEvents={on:(name,fn)=>{const rows=listeners.get(name)??new Set();rows.add(fn);listeners.set(name,rows);return()=>{rows.delete(fn)}},emit:async()=>{}};
  const storage:PluginStorage={get:<T>(k:string)=>structuredClone(saved.get(k)) as T,set:(k,v)=>{saved.set(k,structuredClone(v))},rootDir:()=>"unused"};
  const calls:string[]=[],control=new AbortController();let failRead=false,failCompression=false;
  const snapshot=async()=>{if(failRead)throw Error("unreadable");return structuredClone(messages)};
  const stages={review:vi.fn(async()=>{calls.push("review");return true}),compression:vi.fn(async()=>{calls.push("compression");return !failCompression}),reflection:vi.fn(async()=>{calls.push("reflection");return true})};
  const create=()=>createMaintenanceCycles(storage,events,snapshot,control.signal,stages);
  const clock=create();
  const event=(n:number,final=`a${n}`)=>({eventId:`e${n}-${final}`,conversationId:"c",inputMessageId:`u${n}`,finalMessageId:final,mode:"chat",source:"desktop",chatBackend:"companion",status:"success"} as PluginTurnFinishedEvent);
  const emit=async(name:string,payload:any)=>{await Promise.all([...(listeners.get(name)??[])].map(fn=>fn(payload)))};
  return {clock,create,messages,add,calls,stages,saved,event,emit,control,setReadFail:(v:boolean)=>{failRead=v},setCompressionFail:(v:boolean)=>{failCompression=v}};
}
describe("durable maintenance identity clock",()=>{
  it("does not let an older failed phase starve later cycles",async()=>{
    const f=fixture();await f.clock.start();f.setCompressionFail(true);
    for(let n=20;n<=40;n++){f.add(n);await f.emit("host:turn:finished",f.event(n));}
    expect(f.calls.filter(name=>name==="reflection")).toHaveLength(2);
    expect(f.clock.view().jobs.map(job=>job.phases)).toEqual([["compression"],["compression"]]);f.clock.stop();
  });
  it("retries outstanding phases on the timer without another user message",async()=>{
    vi.useFakeTimers();const f=fixture();try {
      await f.clock.start();f.setCompressionFail(true);f.add(20);await f.emit("host:turn:finished",f.event(20));
      f.setCompressionFail(false);await vi.advanceTimersByTimeAsync(60_000);
      expect(f.clock.view().jobs).toEqual([]);expect(f.calls.filter(name=>name==="reflection")).toHaveLength(1);
    } finally {f.clock.stop();vi.useRealTimers();}
  });
  it("keeps an interrupted phase pending for restart",async()=>{
    const f=fixture();await f.clock.start();let release!:()=>void;
    f.stages.compression.mockImplementation(async()=>{await new Promise<void>(r=>{release=r});return true});
    f.add(20);const running=f.emit("host:turn:finished",f.event(20));await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    f.clock.stop();release();await running;
    expect(f.clock.view().jobs[0].phases).toEqual(["compression","reflection"]);
    f.stages.compression.mockResolvedValue(true);const restarted=f.create();await restarted.start();expect(restarted.view().jobs).toEqual([]);restarted.stop();
  });

  it("uses one twentieth-round cycle and ignores duplicates/regeneration",async()=>{
    const f=fixture();await f.clock.start();expect(f.calls).toEqual([]);f.add(20);await f.emit("host:turn:finished",f.event(20));
    expect(f.calls).toEqual(["review","compression","reflection"]);await f.emit("host:turn:finished",{...f.event(20),eventId:"duplicate"});
    f.messages.at(-1)!.id="replacement";await f.emit("host:turn:finished",f.event(20,"replacement"));expect(f.clock.view().round).toBe(20);expect(f.calls).toHaveLength(3);f.clock.stop();
  });
  it("does not count an unconfirmed regenerated reply until its success event",async()=>{
    const f=fixture();await f.clock.start();f.messages.at(-1)!.id="regenerated";
    await f.emit("host:conversation:changed",{});expect(f.clock.view().round).toBe(18);
    await f.emit("host:turn:finished",f.event(19,"regenerated"));expect(f.clock.view().round).toBe(19);expect(f.calls).toEqual([]);f.clock.stop();
  });
  it("deletion deactivates a known identity without allowing its replay to count again",async()=>{
    const f=fixture();await f.clock.start();const removed=f.messages.splice(0,2);await f.emit("host:conversation:changed",{});expect(f.clock.view().round).toBe(18);
    await f.emit("host:turn:finished",f.event(1));expect(f.clock.view().round).toBe(18);
    f.messages.unshift(...removed);await f.emit("host:turn:finished",f.event(1));expect(f.clock.view().round).toBe(19);expect(f.calls).toEqual([]);f.clock.stop();
  });
  it("retains failed cycle phase across restart without repeating completed stages",async()=>{
    const f=fixture();await f.clock.start();f.setCompressionFail(true);f.add(20);await f.emit("host:turn:finished",f.event(20));
    expect(f.clock.view().jobs[0].phases).toEqual(["compression"]);f.clock.stop();f.setCompressionFail(false);const restarted=f.create();await restarted.start();
    expect(f.calls).toEqual(["review","compression","reflection","compression"]);expect(restarted.view().jobs).toEqual([]);restarted.stop();
  });
  it("does not clear counts on read failure and retries the persisted event",async()=>{
    const f=fixture();await f.clock.start();f.add(20);f.setReadFail(true);await f.emit("host:turn:finished",f.event(20));expect(f.clock.view().round).toBe(19);expect(f.clock.view().inbox).toHaveLength(1);
    f.setReadFail(false);await f.clock.start();expect(f.clock.view().round).toBe(20);expect(f.calls).toEqual(["review","compression","reflection"]);f.clock.stop();
  });
  it("drops remaining stages when the triggering source changes during a phase",async()=>{
    const f=fixture();await f.clock.start();f.stages.compression.mockImplementation(async()=>{f.calls.push("compression");f.messages.at(-1)!.text="edited";return true});
    f.add(20);await f.emit("host:turn:finished",f.event(20));expect(f.calls).toEqual(["review","compression"]);expect(f.clock.view().jobs).toEqual([]);f.clock.stop();
  });
  it("ignores other backends and failed turns",async()=>{
    const f=fixture(4);await f.clock.start();f.add(5);await f.emit("host:turn:finished",{...f.event(5),chatBackend:"native"});await f.emit("host:turn:finished",{...f.event(5),status:"error"});expect(f.clock.view().round).toBe(4);
    await f.emit("host:turn:finished",f.event(5));expect(f.calls).toEqual(["review"]);f.clock.stop();
  });
});
