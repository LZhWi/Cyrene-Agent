"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { cleanup, stopServer } = require("./minecraft-task-test-cleanup.cjs");
function child() {
  const c = new EventEmitter();c.pid=1;c.exitCode=null;c.signalCode=null;c.signals=[];c.writes=[];
  c.stdin=new EventEmitter();c.stdin.writable=true;c.stdin.destroyed=false;
  c.stdin.write=(text,cb)=>{c.writes.push(text);queueMicrotask(()=>{c.exitCode=0;c.emit("exit",0);cb?.();});};
  c.kill=(signal)=>{c.signals.push(signal);queueMicrotask(()=>{c.signalCode=signal;c.emit("exit",null,signal);});};return c;
}
test("failed plugin closes still stop server and remove temporary output",async()=>{
  const c=child();const calls=[];
  await assert.rejects(cleanup({manager:{close(){calls.push("manager");throw Error("manager");}},controller:{async close(){calls.push("controller");throw Error("controller");}},server:c,temporary:"owned-temp",remove:()=>calls.push("remove")}),AggregateError);
  assert.deepEqual(calls,["manager","controller","remove"]);assert.deepEqual(c.writes,["stop\n"]);assert.equal(c.exitCode,0);
});
test("already exited or failed spawn needs no stdin write",async()=>{
  const c=child();c.exitCode=1;await stopServer(c);assert.deepEqual(c.writes,[]);await stopServer({pid:undefined});
});
test("EPIPE and ignored stop escalate and confirm SIGTERM exit",async()=>{
  const c=child();c.stdin.write=()=>{queueMicrotask(()=>c.stdin.emit("error",Error("EPIPE")));};
  await stopServer(c,{gracefulMs:1,termMs:20,killMs:20});assert.deepEqual(c.signals,["SIGTERM"]);assert.equal(c.signalCode,"SIGTERM");
});
test("SIGKILL fallback confirms exit; unconfirmed exit reports failure",async()=>{
  const c=child();c.stdin.write=()=>{};c.kill=signal=>{c.signals.push(signal);if(signal==="SIGKILL")queueMicrotask(()=>{c.signalCode=signal;c.emit("exit",null,signal);});};
  await stopServer(c,{gracefulMs:1,termMs:1,killMs:20});assert.deepEqual(c.signals,["SIGTERM","SIGKILL"]);
  const stuck=child();stuck.stdin.write=()=>{};stuck.kill=()=>false;
  await assert.rejects(stopServer(stuck,{gracefulMs:1,termMs:1,killMs:1}),/not confirmed/);
});
