import {describe,it,expect} from "vitest";
import {mkdtemp,rm,readFile,mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {TaskController,validateGoal} from "./controller";
import type {TaskBody,TaskSnapshot,TaskAction,ActionResult} from "./contracts";
const goal={item:"wooden_pickaxe",allowedRegion:{dimension:"overworld",min:{x:-5,y:60,z:-5},max:{x:5,y:70,z:5}},allowCollect:false,allowPlace:false};
function body(): TaskBody & {snapshot:TaskSnapshot; calls:TaskAction[]; actionImpl?:()=>Promise<ActionResult>} {
 const b={snapshot:{connected:true,inventory:{wooden_pickaxe:1},position:{x:0,y:64,z:0},dimension:"overworld",heldItem:null,owner:{x:123,y:456,z:789},nearbyPlayers:[{name:"private-person"}]} as TaskSnapshot,calls:[] as TaskAction[],actionImpl:undefined as (()=>Promise<ActionResult>)|undefined,
 acquireTask(){},releaseTask(){},async observeTask(){return structuredClone(b.snapshot);},async taskAction(_id:string,a:TaskAction){b.calls.push(a);if(b.actionImpl)return b.actionImpl();b.snapshot.heldItem=a.material;return {id:"a1",action:a.action,status:"completed",after:b.snapshot};},cancel(){}};
 return b;
}
async function terminal(c:TaskController) {for(let n=0;n<100;n++){if(c.status()?.state!=="running") {await new Promise(r=>setTimeout(r,1));return c.status()!;}await new Promise(r=>setTimeout(r,2));}throw new Error("did not finish");}
async function fixture(run:(c:TaskController,b:ReturnType<typeof body>,dir:string)=>Promise<void>) {const dir=await mkdtemp(path.join(os.tmpdir(),"mc-controller-"));const b=body(),c=new TaskController(b,dir);try{await run(c,b,dir);}finally{await c.close();await rm(dir,{recursive:true,force:true});}}
describe("bounded task controller",()=>{
 it("validates strict goal and finite bounded region",()=>{expect(validateGoal(goal).equip).toBe(true);expect(()=>validateGoal({...goal,item:"diamond"})).toThrow();expect(()=>validateGoal({...goal,extra:1})).toThrow();expect(()=>validateGoal({...goal,actionBudget:0})).toThrow();});
 it("gifts satisfy inventory not learned skill; actual equip must be observed",()=>fixture(async(c,b,dir)=>{await c.start(goal);const done=await terminal(c);expect(done.state).toBe("completed");expect(done.skillLearned).toBe(false);expect(b.calls).toEqual([{action:"equip",material:"wooden_pickaxe",timeoutMs:expect.any(Number)}]);const log=await readFile(path.join(dir,"tasks-v1/events.jsonl"),"utf8");expect(log).toContain("action_result");expect(log).not.toContain("private-person");expect(log).not.toContain('"owner"');}));
 it("does not trust completed action text without actual equipped item",()=>fixture(async(c,b)=>{b.actionImpl=async()=>({id:"x",action:"equip",status:"completed"});await c.start({...goal,actionBudget:2});expect((await terminal(c)).state).toBe("blocked");expect(b.calls).toHaveLength(2);}));
 it("uncertain outcome blocks new goals until explicit acknowledgement",()=>fixture(async(c,b)=>{b.actionImpl=async()=>({id:"x",action:"equip",status:"cancelled",effectsUncertain:true});await c.start(goal);expect((await terminal(c)).effectsUncertain).toBe(true);await expect(c.start(goal)).rejects.toThrow(/不确定/);await c.acknowledgeEffects();expect(c.status()?.effectsUncertain).toBe(false);}));
 it("serializes concurrent starts and cancels pending observations before completion",()=>fixture(async(c,b)=>{let resolve!:(s:TaskSnapshot)=>void;b.observeTask=()=>new Promise(r=>resolve=r);await c.start(goal);await expect(c.start(goal)).rejects.toThrow();await c.cancel();resolve(b.snapshot);expect((await terminal(c)).state).toBe("cancelled");expect(b.calls).toHaveLength(0);}));
 it("cancellation during acquisition cannot dispatch",()=>fixture(async(c,b)=>{let release!:()=>void;b.acquireTask=()=>new Promise<void>(r=>release=r);const started=c.start(goal);await c.cancel();release();await expect(started).rejects.toThrow(/取消/);expect(b.calls).toHaveLength(0);}));
 it("IPC loss during mutation is uncertain and never retried",()=>fixture(async(c,b)=>{b.actionImpl=async()=>{throw new Error("lost IPC");};await c.start(goal);const done=await terminal(c);expect(done.effectsUncertain).toBe(true);expect(done.state).toBe("blocked");expect(b.calls).toHaveLength(1);}));
 it("late cancel callback cannot poison a newer goal",()=>fixture(async(c,b)=>{
  let finish!:(s:TaskSnapshot)=>void, rejectCancel!:(e:Error)=>void;
  const originalObserve=b.observeTask;
  b.observeTask=()=>new Promise(r=>finish=r);
  b.cancel=()=>new Promise((_r,reject)=>rejectCancel=reject);
  await c.start(goal); await c.cancel(); finish(b.snapshot); await terminal(c);
  b.observeTask=originalObserve; b.snapshot.heldItem="wooden_pickaxe";
  await c.start(goal); expect((await terminal(c)).state).toBe("completed");
  rejectCancel(new Error("old callback")); await new Promise(r=>setTimeout(r,1));
  expect(c.status()?.effectsUncertain).toBe(false);
 }));
 it("restarts mark running state interrupted without replay",()=>fixture(async(c,b,dir)=>{await mkdir(path.join(dir,"tasks-v1"));await writeFile(path.join(dir,"tasks-v1/state.json"),JSON.stringify({id:"old",goal:validateGoal(goal),state:"running",actions:1,effectsUncertain:false,skillLearned:false}));const old=c.status();expect(old?.state).toBe("interrupted");expect(old?.effectsUncertain).toBe(true);expect(b.calls).toHaveLength(0);await expect(c.start(goal)).rejects.toThrow();}));
});
