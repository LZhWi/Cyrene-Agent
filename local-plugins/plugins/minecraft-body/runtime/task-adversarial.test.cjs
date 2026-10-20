"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { MinecraftBody } = require("./body.cjs");
class P {
  constructor(x=0,y=64,z=0){Object.assign(this,{x,y,z});}
  offset(x,y,z){return new P(this.x+x,this.y+y,this.z+z);}
  floored(){return new P(Math.floor(this.x),Math.floor(this.y),Math.floor(this.z));}
  clone(){return this.offset(0,0,0);}
  distanceTo(p){return Math.hypot(this.x-p.x,this.y-p.y,this.z-p.z);}
  toString(){return `${this.x},${this.y},${this.z}`;}
}
class Movements {constructor(){this.blocksToAvoid=new Set();this.exclusionAreasStep=[];}}
const region=(extra={})=>({dimension:"overworld",min:{x:-4,y:60,z:-4},max:{x:4,y:70,z:4},allowCollect:true,allowPlace:true,...extra});
function setup(r=region()) {
  let items=[];
  const bot={entity:{position:new P()},players:{},entities:{},health:20,food:20,oxygenLevel:20,game:{dimension:"overworld"},
    registry:{blocksByName:{oak_log:{id:1}},itemsByName:{oak_planks:{id:5}}},inventory:{items:()=>items},
    pathfinder:{setGoal(){},setMovements(m){this.movements=m;},async goto(){}},stopDigging(){},clearControlStates(){},deactivateItem(){},
    blockAt:p=>({type:0,name:"air",boundingBox:"empty",position:p}),findBlocks:()=>[],canDigBlock:()=>true,
    recipesFor:()=>[{result:{count:4}}],async craft(){items=[{name:"oak_planks",count:4,type:5}];},async equip(){}};
  const body=new MinecraftBody(bot,{goals:{GoalNear:class{constructor(x,y,z){Object.assign(this,{x,y,z});}}},Movements,owner:"Owner"});
  body.acquireTask("task-a",r);
  const action=(id,action,extra={})=>({id,action,taskId:"task-a",allowedRegion:r,timeoutMs:1000,...extra});
  return {bot,body,action};
}
const flush=()=>new Promise(r=>setImmediate(r));
test("lease denies manual actions and forged permission escalation",async()=>{
  const r=region({allowCollect:false,allowPlace:false}); const {body,action}=setup(r);
  await assert.rejects(body.execute({id:"manual",action:"come",timeoutMs:1000}),/任务/);
  await assert.rejects(body.execute(action("escalate","collect",{material:"木头",count:1,position:new P(2),allowedRegion:region()})),/任务/);
  await assert.rejects(body.execute(action("forbidden","collect",{material:"木头",count:1,position:new P(2)})),/授权|允许|权限/);
});
test("leased safety reflex cancels a stalled mutation on low health",async()=>{
  const {body,bot,action}=setup(); let release;
  bot.craft=()=>new Promise(r=>release=r);
  const pending=body.execute(action("craft","craft",{material:"oak_planks",count:4}));
  bot.health=5; body.reflex();
  const finished=body.active?.finished;
  body.cancel(); release(); await pending; await flush();
  assert.equal(finished,true,"lease must suppress autonomous dispatch, not ongoing health checks");
});
test("lease remains exclusive while cancelled craft drains, then clears",async()=>{
  const {body,bot,action}=setup(); let release;
  bot.craft=()=>new Promise(r=>release=r);
  const pending=body.execute(action("craft","craft",{material:"oak_planks",count:4}));
  const stopped=body.cancel(); assert.equal(stopped.effectsUncertain,true);
  body.releaseTask("task-a"); assert.ok(body.taskLease);
  assert.throws(()=>body.acquireTask("task-b",region()));
  await assert.rejects(body.execute({id:"manual",action:"come",timeoutMs:1000}));
  release(); await pending; await flush(); assert.equal(body.taskLease,null);
});
test("task path exclusion rejects out-of-region cells and old lease cannot release current owner",()=>{
  const {body,bot}=setup(); body.releaseTask("task-old"); assert.equal(body.taskLease.id,"task-a");
  const exclude=bot.pathfinder.movements.exclusionAreasStep.at(-1);
  assert.equal(exclude({position:new P(5)}),Infinity); assert.equal(exclude({position:new P(1)}),0);
});
test("real Body and planner handoff collects, observes drops, picks up, crafts and places",async()=>{
  const {planNext}=require("../src/planner.ts");
  const r=region(); const {body,bot,action}=setup(r); bot.version="1.21.11";
  const names=["oak_log","oak_planks","stick","crafting_table","wooden_pickaxe"];
  const ids=Object.fromEntries(names.map((n,i)=>[n,i+1]));
  const recipes=[
    {id:"planks",output:{name:"oak_planks",count:4},ingredients:[{name:"oak_log",count:1}],requiresTable:false},
    {id:"sticks",output:{name:"stick",count:4},ingredients:[{name:"oak_planks",count:2}],requiresTable:false},
    {id:"table",output:{name:"crafting_table",count:1},ingredients:[{name:"oak_planks",count:4}],requiresTable:false},
    {id:"pickaxe",output:{name:"wooden_pickaxe",count:1},ingredients:[{name:"oak_planks",count:3},{name:"stick",count:2}],requiresTable:true}];
  let inv={}; const world=new Map([1,2,3].map(x=>[new P(x).toString(),"oak_log"])); let dropId=0;
  bot.registry.itemsByName=Object.fromEntries(names.map(n=>[n,{id:ids[n]}]));
  bot.registry.blocksByName={oak_log:{id:ids.oak_log},crafting_table:{id:ids.crafting_table}};
  bot.inventory.items=()=>Object.entries(inv).filter(([,count])=>count>0).map(([name,count])=>({name,count,type:ids[name]}));
  bot.blockAt=p=>{const name=world.get(p.toString())||(p.y===63?"stone":"air");return {name,type:ids[name]||(name==="air"?0:99),position:p,boundingBox:name==="air"?"empty":"block"};};
  bot.findBlocks=({matching})=>[...world].filter(([,name])=>(Array.isArray(matching)?matching:[matching]).includes(ids[name])).map(([p])=>new P(...p.split(",").map(Number)));
  bot.dig=async block=>{world.delete(block.position.toString());const id=++dropId;bot.entities[id]={id,name:"item",position:block.position.clone(),getDroppedItem:()=>({name:"oak_log",count:1})};};
  bot.pathfinder.goto=async goal=>{bot.entity.position=new P(goal.x-(goal.range>1?1:0),goal.y,goal.z);for(const [id,e] of Object.entries(bot.entities))if(e.position.distanceTo(bot.entity.position)<0.6){inv.oak_log=(inv.oak_log||0)+1;delete bot.entities[id];}};
  body.goals.GoalNear=class {constructor(x,y,z,range){Object.assign(this,{x,y,z,range});}};
  bot.recipesFor=(id,_meta,_count,table)=>recipes.filter(r=>ids[r.output.name]===id&&(!r.requiresTable||table)&&r.ingredients.every(i=>(inv[i.name]||0)>=i.count)).map(r=>({...r,result:{count:r.output.count}}));
  bot.craft=async(recipe,times)=>{for(const i of recipe.ingredients)inv[i.name]-=i.count*times;inv[recipe.output.name]=(inv[recipe.output.name]||0)+recipe.output.count*times;};
  bot.equip=async item=>{bot.heldItem=item;};
  bot.placeBlock=async ground=>{world.set(ground.position.offset(0,1,0).toString(),bot.heldItem.name);inv[bot.heldItem.name]--;};
  const goal={item:"wooden_pickaxe",desiredTotal:1,equip:false,allowCollect:true,allowPlace:true,allowedRegion:r,timeoutMs:60000,actionBudget:32};
  const executed=[];
  for(let i=0;i<25;i++){
    const snapshot=body.observeTask(r);snapshot.recipeCatalog={supported:true,version:bot.version,source:"minecraft-data",recipes};
    const decision=planNext(snapshot,goal); assert.notEqual(decision.kind,"blocked",JSON.stringify(decision));
    if(decision.kind==="completed")break;
    executed.push(decision.action.action);const result=await body.execute(action(`step-${i}`,decision.action.action,decision.action));
    assert.equal(result.status,"completed",JSON.stringify(result));await flush();
  }
  assert.equal(inv.wooden_pickaxe,1);assert.ok(executed.includes("pickup"));assert.ok(executed.includes("place"));
});
