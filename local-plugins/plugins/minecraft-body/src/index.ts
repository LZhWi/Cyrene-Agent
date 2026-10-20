import path from "node:path";
import type { CyrenePlugin, PluginTool } from "@playa0v0/cyrene-plugin-sdk";
import { BodyManager } from "./manager";
import { TaskController } from "./controller";

export const createPlugin = (createManager = (runtime: string, data: string) => new BodyManager(runtime, data)): CyrenePlugin => ({
  register(ctx) {
    const manager = createManager(path.join(__dirname, "runtime"), ctx.storage.rootDir());
    const controller = new TaskController(manager, ctx.storage.rootDir());
    ctx.onDispose(async () => { await controller.cancel(); await manager.close(); await controller.close(); });
    const accepting = <T>(action: () => T) => { ctx.signal.throwIfAborted(); return action(); };
    ctx.registerIpc("body-status", () => accepting(() => manager.status()));
    ctx.registerIpc("body-start", (config) => accepting(() => manager.start(config)));
    ctx.registerIpc("body-action", (request) => accepting(() => manager.action(request)));
    ctx.registerIpc("body-cancel", () => accepting(() => { void controller.cancel(); return manager.cancel(); }));
    ctx.registerIpc("body-stop", async () => { await controller.cancel(); return manager.stop(); });
    ctx.registerIpc("task-start", (goal) => accepting(() => controller.start(goal)));
    ctx.registerIpc("task-status", () => accepting(() => controller.status()));
    ctx.registerIpc("task-cancel", () => accepting(() => controller.cancel()));
    ctx.registerIpc("task-acknowledge-effects", () => accepting(() => controller.acknowledgeEffects()));
    const register = (tool: Omit<PluginTool,"enabled">) => ctx.registerTool({...tool,enabled:true,execute:async(args,context)=>{
      ctx.signal.throwIfAborted(); context?.signal?.throwIfAborted(); return tool.execute(args,context);
    }});
    const point = {type:"object" as const,properties:{x:{type:"number" as const},y:{type:"number" as const},z:{type:"number" as const}},required:["x","y","z"]};
    register({
      id:"minecraft-body_start_goal",name:"开始 MC 木镐目标",risk:"input-control",effectKind:"external_side_effect",verificationPolicy:"unknown",
      description:"仅在已手动连接的 Minecraft 身体上执行木镐总量1的有界任务。会改变游戏世界，须给定允许区域和采集/放置许可。单动作后核验再规划，无额外模型调用。不连接服务器，不自动恢复失败任务。返回任务ID，使用 status 查看实际结果。",
      inputSchema:{type:"object",properties:{item:{type:"string",enum:["wooden_pickaxe"]},desiredTotal:{type:"integer",description:"仅允许1"},equip:{type:"boolean",description:"默认true，完成必须真实手持木镐"},allowedRegion:{type:"object",properties:{dimension:{type:"string",enum:["overworld"]},min:point,max:point},required:["dimension","min","max"]},allowCollect:{type:"boolean"},allowPlace:{type:"boolean"},timeoutMs:{type:"integer",description:"1000..300000，默认120000"},actionBudget:{type:"integer",description:"1..32，默认16"}},required:["item","allowedRegion","allowCollect","allowPlace"]},
      async execute(args){return JSON.stringify(await controller.start(args));},
    });
    register({id:"minecraft-body_task_status",name:"查看 MC 任务状态",risk:"safe",effectKind:"read",verificationPolicy:"none",description:"查看任务真实状态、最后观测和动作结果。completed只是当前物品/装备目标满足，不代表学会技能；blocked不自动重试。不确定效果只能由用户在面板IPC明确确认后解除。",inputSchema:{type:"object",properties:{},required:[]},async execute(){return JSON.stringify(controller.status());}});
    register({id:"minecraft-body_cancel_task",name:"停止 MC 任务",risk:"input-control",effectKind:"external_side_effect",verificationPolicy:"unknown",description:"停止当前目标；底层调用可能仍在draining。不会撤销已发生世界修改，不会自动恢复。",inputSchema:{type:"object",properties:{},required:[]},async execute(){return JSON.stringify(await controller.cancel());}});
    // No prompt providers, channels, chat listeners, memory service, or LLM calls.
  },
});
export default createPlugin();
