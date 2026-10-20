import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, existsSync, lstatSync, readFileSync, writeFileSync, appendFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { TaskBody, TaskGoal, TaskRecord, AllowedRegion, TaskSnapshot } from "./contracts";
import { planNext } from "./planner";

export function validateGoal(value: unknown): TaskGoal {
  if (!value || typeof value !== "object") throw new Error("结构化目标无效");
  const v = value as Record<string, any>;
  const keys = ["item", "desiredTotal", "equip", "allowedRegion", "allowCollect", "allowPlace", "timeoutMs", "actionBudget"];
  if (Object.keys(v).some(k => !keys.includes(k)) || v.item !== "wooden_pickaxe" || (v.desiredTotal !== undefined && v.desiredTotal !== 1)) throw new Error("V1 仅支持 wooden_pickaxe 总量 1");
  const r = v.allowedRegion;
  if (!r || typeof r.dimension !== "string" || !["overworld", "minecraft:overworld"].includes(r.dimension)) throw new Error("必须指定主世界允许区域");
  for (const axis of ["x", "y", "z"]) {
    if (!Number.isFinite(r.min?.[axis]) || !Number.isFinite(r.max?.[axis]) || r.max[axis] < r.min[axis] || r.max[axis] - r.min[axis] > 48 || Math.abs(r.min[axis]) > 30000000 || Math.abs(r.max[axis]) > 30000000) throw new Error("允许区域每边须在 0..48 格内");
  }
  for (const key of ["equip", "allowCollect", "allowPlace"]) if (v[key] !== undefined && typeof v[key] !== "boolean") throw new Error(`${key} 须为布尔值`);
  const timeoutMs = v.timeoutMs ?? 120000, actionBudget = v.actionBudget ?? 16;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000 || !Number.isInteger(actionBudget) || actionBudget < 1 || actionBudget > 32) throw new Error("时间预算 1000..300000 毫秒；动作预算 1..32");
  return { item: "wooden_pickaxe", desiredTotal: 1, equip: v.equip !== false, allowedRegion: {dimension:"overworld",min:{x:r.min.x,y:r.min.y,z:r.min.z},max:{x:r.max.x,y:r.max.y,z:r.max.z}}, allowCollect: v.allowCollect === true, allowPlace: v.allowPlace === true, timeoutMs, actionBudget };
}

function sanitizeSnapshot(s: TaskSnapshot): TaskSnapshot {
  const {connected,position,dimension,inventory,heldItem,health,activeAction,sampledAt,taskObservation,protocolVersion}=s;
  return {connected,position,dimension,inventory,heldItem,health,activeAction,sampledAt,taskObservation,protocolVersion};
}

/** Only plugin-owned bounded journal/state. No host conversation or memory access. */
class Journal {
  private root: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    const base = realpathSync(root); this.root = path.join(base, "tasks-v1");
    mkdirSync(this.root, { recursive: true });
    if (realpathSync(this.root) !== this.root) throw new Error("任务目录不能是符号链接");
  }
  private file(name: string) { const file = path.join(this.root, name); if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("任务文件不能是符号链接"); return file; }
  load(): TaskRecord | undefined { const f=this.file("state.json"); if (!existsSync(f)) return; if(statSync(f).size>1024*1024) throw new Error("任务状态文件过大"); return JSON.parse(readFileSync(f,"utf8")); }
  write(task: TaskRecord) { const temp=this.file("state.tmp"); writeFileSync(temp,JSON.stringify(task),{mode:0o600}); renameSync(temp,this.file("state.json")); }
  append(event: unknown) {
    const file=this.file("events.jsonl");
    if (existsSync(file) && statSync(file).size > 4*1024*1024) { rmSync(this.file("events.2.jsonl"),{force:true}); if(existsSync(this.file("events.1.jsonl"))) renameSync(this.file("events.1.jsonl"),this.file("events.2.jsonl")); renameSync(file,this.file("events.1.jsonl")); }
    appendFileSync(file,JSON.stringify({time:new Date().toISOString(),...event as object})+"\n",{mode:0o600});
  }
}

export class TaskController {
  private task?: TaskRecord;
  private journal?: Journal;
  private starting=false;
  private closed=false;
  private loop?: Promise<void>;
  private cancelRequested=false;
  constructor(private body: TaskBody, private dataRoot: string) {}
  private init() {
    if(this.journal) return;
    this.journal=new Journal(this.dataRoot); this.task=this.journal.load();
    if(this.task?.state === "running") { this.task.state="interrupted"; this.task.reason="插件重启；不恢复或重放任务。请核对现场后确认不确定效果"; this.task.effectsUncertain=true; this.save("restart_interrupted"); }
  }
  private save(event: string, detail: object = {}) { if(!this.task) return; this.task.updatedAt=new Date().toISOString(); this.journal!.append({event,taskId:this.task.id,task:this.task,...detail}); this.journal!.write(this.task); }
  status() { this.init(); return this.task ? JSON.parse(JSON.stringify(this.task)) as TaskRecord : null; }
  async start(value: unknown) {
    if(this.closed) throw new Error("插件已停止");
    if(this.starting || this.loop) throw new Error("已有任务运行或正在停止");
    this.init(); if(this.task?.effectsUncertain) throw new Error("上次任务效果不确定；先核对现场并显式确认");
    const goal=validateGoal(value); this.cancelRequested=false; goal.allowedRegion.allowCollect=goal.allowCollect; goal.allowedRegion.allowPlace=goal.allowPlace; this.starting=true;
    const id=randomUUID();
    try {
      await this.body.acquireTask(id,goal.allowedRegion);
      if(this.closed || this.cancelRequested) throw new Error("任务启动已取消");
      this.task={id,goal,state:"running",reason:"目标已接收",startedAt:new Date().toISOString(),updatedAt:new Date().toISOString(),actions:0,effectsUncertain:false,skillLearned:false};
      this.save("task_started");
      this.loop=this.run(this.task).catch(error=>{if(this.task){this.task.state="blocked";this.task.reason=`任务记录或清理失败：${String(error)}`;this.task.effectsUncertain=true;}}).finally(()=>{this.loop=undefined;});
      return this.status();
    } catch(error) { if(this.task?.id===id){this.task.state="blocked";this.task.effectsUncertain=true;this.task.reason=String(error);} await this.body.releaseTask(id); throw error; }
    finally { this.starting=false; }
  }
  private requestCancel() {
    const cancellingTask=this.task;
    const fail=(error:unknown)=>{if(cancellingTask && this.task===cancellingTask){cancellingTask.effectsUncertain=true;cancellingTask.reason=`取消调用失败：${String(error)}`;}};
    try {const result=this.body.cancel(); if(result && typeof (result as Promise<unknown>).catch === "function") void (result as Promise<unknown>).catch(fail);} catch(error) {fail(error);}
  }
  async cancel() {
    this.cancelRequested=true;
    if(!this.journal && !this.starting && !this.loop) return null;
    this.init();
    if(this.loop) { this.requestCancel(); if(this.task) {this.task.reason="取消已请求，等待底层动作结束；不会启动下一步"; this.save("cancel_requested");} }
    return this.status();
  }
  async acknowledgeEffects() {
    this.init(); if(this.loop || this.starting) throw new Error("等待任务及底层动作结束后再确认");
    if(this.task?.effectsUncertain) { await this.body.assertQuiescent?.(this.task.goal.allowedRegion); this.task.effectsUncertain=false; this.task.reason="用户已确认现场；旧任务仍不恢复，下一次须显式新建"; this.save("effects_acknowledged"); }
    return this.status();
  }
  private async run(task: TaskRecord) {
    const deadline=Date.now()+task.goal.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer=setTimeout(()=>{this.cancelRequested=true; this.requestCancel();},task.goal.timeoutMs);
      while(true) {
        if(this.cancelRequested || this.closed) {task.state="cancelled";task.reason=Date.now()>=deadline?"时间预算已到":"任务已停止";break;}
        const observed=await this.body.observeTask(task.id,task.goal.allowedRegion);
        const before=sanitizeSnapshot(observed); task.lastSnapshot=before;
        if(this.cancelRequested || this.closed) continue;
        if(!before.connected) {task.state="interrupted";task.reason="身体断开；不自动恢复";break;}
        if(before.activeAction) {task.state="blocked";task.reason="身体动作槽尚未释放（含 draining）";break;}
        let decision=planNext(observed,{...task.goal,actionBudget:task.goal.actionBudget-task.actions});
        if(decision.kind === "completed" && task.goal.equip && before.heldItem !== "wooden_pickaxe") decision={kind:"action",action:{action:"equip",material:"wooden_pickaxe"},reason:"背包目标已满足，仍须核验实际手持"};
        this.save("observed_plan",{before,decision});
        if(decision.kind!=="action") { task.state=decision.kind;task.reason=decision.reason; if(decision.kind==="completed") task.outcomeBasis="observed_inventory_and_equipment";break; }
        if(task.actions>=task.goal.actionBudget || Date.now()>=deadline) {task.state="blocked";task.reason="任务预算耗尽";break;}
        if(this.cancelRequested || this.closed) continue;
        const action={...decision.action,timeoutMs:Math.max(1000,Math.min(30000,deadline-Date.now()))};
        task.actions++; this.save("action_intent",{before,action,actionSequence:task.actions});
        let result;
        try { result=await this.body.taskAction(task.id,action,task.goal.allowedRegion); }
        catch(error) { task.effectsUncertain=true; throw error; }
        result={...result,before:result.before?sanitizeSnapshot(result.before):undefined,after:result.after?sanitizeSnapshot(result.after):undefined}; task.lastAction=result;
        task.effectsUncertain=task.effectsUncertain || !!result.effectsUncertain;
        this.save("action_result",{actionId:result.id,before,result,after:result.after});
        if(task.effectsUncertain) {task.state="blocked";task.reason="动作效果不确定；停止自动执行，需核对现场并确认";break;}
        if(this.cancelRequested || this.closed) continue;
        if(result.status!=="completed") {task.state=result.status==="disconnected"?"interrupted":"blocked";task.reason=`动作未完成：${result.reason||result.status}`;break;}
        // Never trust a completion string: loop requests a fresh actual snapshot.
      }
    } catch(error) { task.state="blocked";task.reason=error instanceof Error?error.message:String(error); if(task.lastAction?.effectsUncertain) task.effectsUncertain=true; }
    finally { clearTimeout(timer); try {await this.body.releaseTask(task.id);} catch(error) {task.effectsUncertain=true;task.state="blocked";task.reason=`释放身体失败：${String(error)}`;} this.save("task_finished"); }
  }
  async close() { this.closed=true; await this.cancel(); await this.loop; }
}
