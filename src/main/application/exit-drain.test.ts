import { expect, it, vi } from "vitest";
import { createPendingTurnLifecycle } from "../plugin-host/pending-turn-lifecycle";
import { createPluginEventBus } from "../../plugins/events";
import { createIpcScope } from "./ipc-scope";
vi.mock("electron", () => ({ ipcMain: {} }));
function pending() {
  const published=vi.fn(), abandoned=vi.fn();
  const lifecycle=createPendingTurnLifecycle({publisher:{publishTurnStarted:vi.fn(),publishTurnFinished:published} as any,onAbandon:abandoned});
  lifecycle.beginTurn({runId:"r",conversationId:"c",inputMessageId:"u",mode:"chat",startedAt:0});
  lifecycle.settleTerminal("r",{status:"success"});
  return {lifecycle,published,abandoned};
}
it("drains only after a real persistence acknowledgement, once",async()=>{
  const {lifecycle,published}=pending();let done=false;
  const drain=lifecycle.drain(new AbortController().signal).then(()=>{done=true;});
  await Promise.resolve();expect(done).toBe(false);expect(published).not.toHaveBeenCalled();
  lifecycle.confirmPersistence("r",{finalMessageId:"a"});await drain;
  lifecycle.confirmPersistence("r",{finalMessageId:"a"});expect(published).toHaveBeenCalledTimes(1);
});
it("exit deadline records abandonment without inventing a successful event",async()=>{
  const {lifecycle,published,abandoned}=pending();const c=new AbortController();
  const drain=lifecycle.drain(c.signal);c.abort();await drain;
  expect(published).not.toHaveBeenCalled();expect(abandoned).toHaveBeenCalledWith("r","shutdown deadline before persistence ack");
  expect(lifecycle.pendingCount()).toBe(0);
});
it("sender disposal releases a receipt drain",async()=>{
  const {lifecycle,published}=pending();const drain=lifecycle.drain(new AbortController().signal);
  lifecycle.disposeEntry("r");await drain;expect(published).not.toHaveBeenCalled();
});
it("plugin drain includes not-yet-dispatched listeners without blocking normal emit",async()=>{
  const bus=createPluginEventBus();let release!:()=>void,done=false;
  bus.on("host:test",()=>new Promise<void>(r=>{release=r;}));
  const emitted=bus.emit("host:test",{});const drain=bus.drain().then(()=>{done=true;});
  await emitted;expect(done).toBe(false);release();await drain;
});
it("plugin drain covers nested events and rejected listeners",async()=>{
  const errors=vi.fn(),bus=createPluginEventBus(errors);let release!:()=>void,done=false;
  bus.on("host:child",()=>new Promise<void>(r=>{release=r;}));
  bus.on("host:parent",async()=>{await bus.emit("host:child",{});throw Error("synthetic");});
  await bus.emit("host:parent",{});const drain=bus.drain().then(()=>{done=true;});
  await vi.waitFor(()=>expect(release).toBeTypeOf("function"));expect(done).toBe(false);
  release();await drain;expect(errors).toHaveBeenCalledTimes(1);
});
it("IPC shutdown replies bypass disposed services and preserve removal of other endpoints",()=>{
  const handlers=new Map<string,Function>(),original=vi.fn(()=>42);
  const main={handle:(c:string,f:Function)=>handlers.set(c,f),removeHandler:(c:string)=>handlers.delete(c),on:vi.fn(),removeListener:vi.fn()};
  const ipc=createIpcScope(main);ipc.handle("poll",original);ipc.handle("mutate",original);
  expect(handlers.get("poll")!()).toBe(42);original.mockClear();
  ipc.dispose({poll:{x:0,y:0}});ipc.dispose();
  expect(handlers.get("poll")!()).toEqual({x:0,y:0});expect(handlers.has("mutate")).toBe(false);expect(original).not.toHaveBeenCalled();
});
