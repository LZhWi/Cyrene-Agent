import { describe, expect, it, vi } from "vitest";
import type { PluginEvents, PluginStorage, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { createAutoCompression } from "../plugins/companion-memory/src/auto-compression";
import { createAutoReflection } from "../plugins/companion-memory/src/auto-reflection";
import { createMaintenanceOrder } from "../plugins/companion-memory/src/maintenance-order";
function setup(failFirst = false) {
  const data = new Map<string, unknown>();
  const storage: PluginStorage = { get: <T>(k: string) => data.get(k) as T, set: (k,v) => { data.set(k,v); }, rootDir: () => "unused" };
  const listeners = new Set<(e: any) => any>();
  const events: PluginEvents = { on: (_name, fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, emit: async () => {} };
  const acquire = createMaintenanceOrder(), log: string[] = [];
  let now = 100_000, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let attempts = 0;
  const compression = createAutoCompression(storage, events, () => [{id:"a",entryIds:["a"]},{id:"b",entryIds:["b"]}], async c => {
    log.push("compress:"+c.id); await gate;
    if (failFirst && c.id === "a" && attempts++ === 0) throw Error("retryable");
    return c;
  }, () => now, async (c: any) => { log.push("apply:"+c.id); return {applied:true}; }, undefined, acquire);
  const reflection = createAutoReflection(storage, events, async () => { log.push("reflect"); return {suggested:0}; }, () => now, acquire);
  compression.set(true); compression.setApply(true); reflection.set(true);
  const event = { mode:"chat",source:"desktop",chatBackend:"companion",status:"success" } as PluginTurnFinishedEvent;
  return {compression,reflection,log,release,advance:()=>{now+=60_001},emit:()=>Promise.all([...listeners].map(fn=>fn(event)))};
}
describe("compression before reflection", () => {
  it("waits for the complete compression batch and its writes", async () => {
    const f=setup(); for(let i=0;i<19;i++)await f.emit();const pending=f.emit();await Promise.resolve();await Promise.resolve();
    await vi.waitFor(() => expect(f.log).toEqual(["compress:a"])); f.release();await pending;
    expect(f.log).toEqual(["compress:a","apply:a","compress:b","apply:b","reflect"]);
  });
  it("isolates candidate errors and retains failed candidates for retry", async () => {
    const f=setup(true);f.release();for(let i=0;i<20;i++)await f.emit();
    expect(f.log).toEqual(["compress:a","compress:b","apply:b","reflect"]);
    expect(f.compression.view().lastErrorAt).toBeDefined();expect(f.compression.view().handledCandidateIds).toEqual(["b"]);
    f.advance();for(let i=0;i<20;i++)await f.emit();
    expect(f.log.slice(4)).toEqual(["compress:a","apply:a","reflect"]);
    expect(f.compression.view().lastErrorAt).toBeUndefined();
  });
  it("does not run reflection disabled while waiting", async () => {
    const f=setup();for(let i=0;i<19;i++)await f.emit();const pending=f.emit();await Promise.resolve();f.reflection.set(false);f.release();await pending;
    expect(f.log).not.toContain("reflect");expect(f.reflection.view().lastErrorAt).toBeUndefined();
  });
  it("releases a cancelled queue position so future maintenance can run", async () => {
    const acquire=createMaintenanceOrder(),signal=new AbortController();const release=await acquire(signal.signal);
    const cancelled=new AbortController(),queued=acquire(cancelled.signal);cancelled.abort();await expect(queued).rejects.toThrow("取消");
    let entered=false;const waiting=acquire(signal.signal).then(unlock=>{entered=true;return unlock;});await Promise.resolve();expect(entered).toBe(false);release();(await waiting)();
    const next=await acquire(signal.signal);next();
  });
});
