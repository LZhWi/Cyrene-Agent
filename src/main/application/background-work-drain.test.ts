import { beforeEach, expect, it, vi } from "vitest";
beforeEach(()=>vi.resetModules());
it("accepted LLM work keeps the existing rate-limit retry while draining",async()=>{
  vi.useFakeTimers();try{
    const q=await import("../llm-queue");const task=vi.fn().mockRejectedValueOnce(new Error("429 rate limit")).mockResolvedValue("ok");
    const job=q.enqueueLLMTask("retry",task,{log:false});let done=false;const drain=q.drainLLMQueue(new AbortController().signal).then(()=>{done=true;});
    await vi.advanceTimersByTimeAsync(4999);expect(done).toBe(false);expect(task).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);await drain;expect(await job).toBe("ok");expect(task).toHaveBeenCalledTimes(2);
  }finally{vi.useRealTimers();}
});
it("LLM drain preserves FIFO and waits for accepted jobs, rejecting new admission",async()=>{
  const q=await import("../llm-queue");let release!:()=>void;const calls:string[]=[];
  const first=q.enqueueLLMTask("first",async()=>{calls.push("first");await new Promise<void>(r=>{release=r;});},{log:false});
  const second=q.enqueueLLMTask("second",async()=>{calls.push("second");},{log:false});
  let done=false;const drain=q.drainLLMQueue(new AbortController().signal).then(()=>{done=true;});
  await Promise.resolve();expect(done).toBe(false);expect(calls).toEqual(["first"]);
  await expect(q.enqueueLLMTask("late",async()=>{}, {log:false})).rejects.toThrow("APPLICATION_STOPPING");
  release();await Promise.all([first,second,drain]);expect(calls).toEqual(["first","second"]);
});
it("LLM rejection does not break accepted successors or drain",async()=>{
  const q=await import("../llm-queue");
  const failed=q.enqueueLLMTask("failure",async()=>{throw Error("synthetic");},{log:false});
  const check=expect(failed).rejects.toThrow("synthetic");
  const next=q.enqueueLLMTask("next",async()=>42,{log:false});
  await q.drainLLMQueue(new AbortController().signal);await check;expect(await next).toBe(42);
});
it("deadline diagnoses active LLM and prevents queued work starting afterward",async()=>{
  const q=await import("../llm-queue"),warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
  let release!:()=>void;const first=q.enqueueLLMTask("active",()=>new Promise<void>(r=>{release=r;}),{log:false});
  const fn=vi.fn();const second=q.enqueueLLMTask("queued",fn,{log:false});const rejected=expect(second).rejects.toThrow("APPLICATION_STOPPING");
  const c=new AbortController();const drain=q.drainLLMQueue(c.signal);await Promise.resolve();c.abort();await drain;
  expect(warn).toHaveBeenCalledWith("[Shutdown] unfinished LLM jobs",["active","queued"]);
  release();await first;await rejected;expect(fn).not.toHaveBeenCalled();warn.mockRestore();
});
it("index drain waits for running and queued document jobs without changing order",async()=>{
  const {createDocumentIndexQueue}=await import("../rag/document-index-queue");const index=await import("./background-index-work");
  let release!:(x:any)=>void;const calls:string[]=[];
  const queue=createDocumentIndexQueue({runner:async job=>{calls.push(job.input.filePath);if(calls.length===1)return await new Promise(r=>{release=r;});return {kind:"empty",name:job.input.filePath};}});
  const a=queue.enqueue({filePath:"a",query:"",onProgress:()=>{}}),b=queue.enqueue({filePath:"b",query:"",onProgress:()=>{}});
  let done=false;const drain=index.drainBackgroundIndexes(new AbortController().signal).then(()=>{done=true;});
  await Promise.resolve();expect(done).toBe(false);
  expect(await queue.enqueue({filePath:"late",query:"",onProgress:()=>{}}).promise).toMatchObject({reason:"APPLICATION_STOPPING"});
  release({kind:"empty",name:"a"});await Promise.all([a.promise,b.promise,drain]);expect(calls).toEqual(["a","b"]);
});
it("index deadline releases wait with unfinished labels, not a false completion",async()=>{
  const index=await import("./background-index-work"),warn=vi.spyOn(console,"warn").mockImplementation(()=>{});let release!:()=>void;
  const task=index.trackBackgroundIndex("visual-history",()=>new Promise<void>(r=>{release=r;}));const c=new AbortController();
  const drain=index.drainBackgroundIndexes(c.signal);c.abort();await drain;
  expect(warn).toHaveBeenCalledWith("[Shutdown] unfinished background indexes",["visual-history"]);release();await task;warn.mockRestore();
});
it("LLM-produced index work is awaited before persistence flush",async()=>{
  const q=await import("../llm-queue"),index=await import("./background-index-work");
  const {createShutdownCoordinator}=await import("./shutdown"),{createStartupReadiness}=await import("./readiness");let release!:()=>void;
  const created=q.enqueueLLMTask("creates-index",async()=>{void index.trackBackgroundIndex("derived",()=>new Promise<void>(r=>{release=r;}));},{log:false});
  const coordinator=createShutdownCoordinator({readiness:createStartupReadiness()});const flushed=vi.fn();
  coordinator.register({id:"background-work",phase:"drainBackgroundWork",dispose:async signal=>{await q.drainLLMQueue(signal);await index.drainBackgroundIndexes(signal);}});
  coordinator.register({id:"flush",phase:"flushPersistence",dispose:flushed});
  const shutdown=coordinator.requestControlledShutdown({reason:"test",finalAction:()=>{}});await created;expect(flushed).not.toHaveBeenCalled();
  release();await shutdown;expect(flushed).toHaveBeenCalledTimes(1);
});
