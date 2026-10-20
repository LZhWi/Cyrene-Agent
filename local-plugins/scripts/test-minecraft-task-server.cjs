"use strict";
// Explicitly destructive fixture test. Never point this at a valuable world.
// No downloads, EULA acceptance, production installation, or network binding changes.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const { cleanup } = require("./minecraft-task-test-cleanup.cjs");
const { validateServerDirectory } = require("./minecraft-task-test-guards.cjs");
const args = process.argv.slice(2);
if (args.length !== 3 || args[0] !== "--server-dir" || args[2] !== "--allow-reset-fixtures") {
  throw new Error("Usage: node scripts/test-minecraft-task-server.cjs --server-dir <disposable-server-dir> --allow-reset-fixtures. Requires Java21+, official Vanilla1.21.11 server.jar, existing user-accepted eula=true, loopback offline server.properties, level-name=isolated-test-world. This resets fixtures/player inventory in that world.");
}
const root = fs.realpathSync(args[1]);
validateServerDirectory(root);
const plugin = path.resolve(__dirname, "../plugins/minecraft-body");
const runtime = path.join(plugin, "runtime");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-mc-live-"));
const compiled = path.join(temporary,"plugin-classes.cjs");
buildSync({stdin:{contents:`export {BodyManager} from ${JSON.stringify(path.join(plugin,"src/manager.ts"))};export {TaskController} from ${JSON.stringify(path.join(plugin,"src/controller.ts"))};`,resolveDir:plugin,loader:"ts"},bundle:true,platform:"node",format:"cjs",outfile:compiled});
const { BodyManager, TaskController } = require(compiled);
const runId = Date.now();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const results=[];let manager,controller,server;let output='';let serverFailure;
async function until(fn,ms=30000){let end=Date.now()+ms;while(Date.now()<end){if(serverFailure)throw serverFailure;const v=fn();if(v)return v;await sleep(50);}throw Error('Wait timeout');}
function cmd(s){server.stdin.write(s+'\n');}
async function setup(){for(const s of ['fill -8 64 -8 8 64 8 minecraft:grass_block','fill -8 65 -8 8 72 8 minecraft:air','kill @e[type=minecraft:item]','clear TestBot','tp TestBot 0.5 65 0.5','setblock 2 65 0 minecraft:oak_log','setblock 3 65 0 minecraft:oak_log','setblock 2 65 1 minecraft:oak_log','setblock 3 65 1 minecraft:oak_log'])cmd(s);await sleep(1200);}
const region={dimension:'overworld',min:{x:-8,y:64,z:-8},max:{x:8,y:72,z:8}};
async function goal(name,opts={},cancel=false){const before=manager.status().state; await controller.start({item:'wooden_pickaxe',allowedRegion:region,allowCollect:true,allowPlace:true,...opts}); if(cancel){await until(()=>manager.status().state.activeAction,10000);await controller.cancel();}await until(()=>controller.status()?.state!=='running',180000);await sleep(750); const task=controller.status(),after=manager.status().state;results.push({name,task,before,after});fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(results,null,2));console.log(name,JSON.stringify(task));return {task,after};}
(async()=>{server=spawn('java',['-Xms512M','-Xmx2G','-jar','server.jar','nogui'],{cwd:root,stdio:['pipe','pipe','pipe']});server.once('error',error=>{serverFailure=error;});server.stdin.on('error',error=>{serverFailure=error;});server.once('exit',(code)=>{if(!output.includes('Done ('))serverFailure=new Error('Test server exited before startup: '+code);});const log=fs.createWriteStream(path.join(root,'server.log'));server.stdout.on('data',b=>{output+=b;log.write(b);});server.stderr.on('data',b=>log.write(b));await until(()=>output.includes('Done ('),60000);assert.match(output,/Starting minecraft server version 1\.21\.11(?:\s|$)/);cmd('setworldspawn 0 65 0');cmd('fill -8 64 -8 8 64 8 minecraft:grass_block');
manager=new BodyManager(runtime,path.join(root,'plugin-data-'+runId));controller=new TaskController(manager,path.join(root,'plugin-data-'+runId));await manager.start({host:'127.0.0.1',port:25575,username:'TestBot',owner:'TestOwner',auth:'offline',version:'1.21.11',autoSurvival:false});await until(()=>manager.status().state.connected,30000);await setup();
let r=await goal('collect_permission_denied',{allowCollect:false});assert.equal(r.task.state,'blocked');assert.equal(r.task.actions,0);
await setup();r=await goal('placement_permission_denied',{allowPlace:false});assert.equal(r.task.state,'blocked');assert.equal(r.task.actions,0);
for(let repetition=1;repetition<=3;repetition++){await setup();r=await goal('wooden_pickaxe_full_cycle_'+repetition);assert.equal(r.task.state,'completed');assert.equal(r.after.heldItem,'wooden_pickaxe');assert.equal(r.after.inventory.wooden_pickaxe,1);}
await setup();r=await goal('cancel_during_action',{},true);assert.equal(r.task.state,'blocked');assert.equal(r.task.lastAction.status,'cancelled');assert.equal(r.task.effectsUncertain,true);assert.equal(r.task.actions,1);await sleep(2000);assert.equal(controller.status().actions,1);await until(()=>manager.status().state.activeAction===null,10000);await assert.rejects(()=>controller.start({item:'wooden_pickaxe',allowedRegion:region,allowCollect:true,allowPlace:true}),/不确定/);
await controller.acknowledgeEffects();await assert.rejects(()=>controller.start({item:'wooden_pickaxe',allowedRegion:{dimension:'overworld',min:{x:20,y:64,z:20},max:{x:25,y:72,z:25}},allowCollect:true,allowPlace:true}),/区域|租约/);assert.equal(manager.status().running,false);results.push({name:'outside_region_rejected',pass:true});fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(results,null,2));console.log('LIVE TESTS FINISHED');})().catch(e=>{console.error(e.stack);fs.writeFileSync(path.join(root,'failure.txt'),e.stack);process.exitCode=1;}).finally(async()=>{
  try { await cleanup({manager,controller,server,temporary}); console.log('CLEANED: plugin closes and server exit confirmed'); }
  catch(error) { console.error(error); process.exitCode=1; }
});
