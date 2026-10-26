const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const runtime=process.env.SQLITE_TEST_RUNTIME,stage=process.env.SQLITE_TEST_ROOT,compiled=process.env.SQLITE_TEST_COMPILED;
if(!runtime||!stage||!compiled)throw Error('isolated paths required');
let profile;const load=Module._load;Module._load=function(id,...args){if(id==='electron')return {app:{getPath:()=>profile}};return load.call(this,id,...args);};
const formal=require(path.join(runtime,'formal-storage.cjs')),{importServices}=require(path.join(runtime,'startup-service-import.cjs'));
const services=require(path.join(compiled,'main/storage/service-state.js'));
const {createSchedulerStore}=require(path.join(compiled,'main/scheduler/scheduler-store.js'));
const {createReactionQueue}=require(path.join(compiled,'main/moments/reaction-queue.js'));
const policy=require(path.join(compiled,'main/moments/moments-policy.js'));
const put=(name,value)=>fs.writeFileSync(path.join(profile,name),JSON.stringify(value));
async function fixture(t){profile=fs.mkdtempSync(path.join(stage,'background-'));await formal.migrate(profile,runtime);let owner;
 const start=()=>{owner=require(path.join(runtime,'bridge.cjs'))(formal.options(profile,runtime));owner.start();return owner;};
 const state=ns=>({get:key=>owner.call('services.get',ns,key),set:(key,value)=>owner.call('services.set',ns,key,value)});
 services.setServiceStateProvider((_root,ns)=>state(ns));
 t.after(async()=>{await owner?.stop();fs.rmSync(profile,{recursive:true,force:true});});return {start,state,stop:()=>owner.stop()};}

test('background import is atomic, preserves fields, retries and ignores retired JSON after restart',async t=>{
 const f=await fixture(t);let o=f.start();
 assert.throws(()=>o.call('services.importBackground',{bundle:{scheduler:{tasks:{tasks:[]},history:[]},'moments-policy':{state:{}}},sources:{}}),/BACKGROUND_IMPORT_NAMESPACE_MISSING/);
 assert.equal(o.call('services.initialized','scheduler'),false);
 put('scheduled-tasks.json',{tasks:[],extra:'preserved'});put('moments-state.json',{recentEventKeys:['one'],extra:42});
 put('moments-reaction-queue.json',{tasks:[],extra:true});fs.writeFileSync(path.join(profile,'scheduled-tasks-history.jsonl'),'bad');
 assert.throws(()=>importServices(profile,o.call));assert.equal(o.call('services.backgroundReceipt'),null);assert.equal(o.call('services.initialized','scheduler'),false);
 fs.writeFileSync(path.join(profile,'scheduled-tasks-history.jsonl'),JSON.stringify({id:'h',taskId:'t',firedAt:'2026-10-26',extra:9})+'\n');
 importServices(profile,o.call);assert.equal(f.state('scheduler').get('tasks').extra,'preserved');assert.equal(f.state('scheduler').get('history')[0].extra,9);
 assert.equal(policy.loadMomentsPolicyState().extra,42);const state=policy.loadMomentsPolicyState();policy.saveMomentsPolicyState({...state,recentEventKeys:['new']});
 for(const file of ['scheduled-tasks.json','scheduled-tasks-history.jsonl','moments-state.json','moments-reaction-queue.json'])fs.unlinkSync(path.join(profile,file));
 await f.stop();o=f.start();importServices(profile,o.call);assert.deepEqual(policy.loadMomentsPolicyState().recentEventKeys,['new']);
 assert.equal(f.state('moments-reactions').get('state').extra,true);assert(!fs.existsSync(path.join(profile,'moments-state.json')));
});

test('scheduler SQL and explicit JSON fixture give equal task/history results; failed write restores cache',async t=>{
 const f=await fixture(t),o=f.start();importServices(profile,o.call);
 const deps={tasksFile:path.join(profile,'fixture-tasks.json'),historyFile:path.join(profile,'fixture-history.jsonl'),now:()=>new Date('2026-10-26T08:00:00Z'),id:()=> 'fixed'};
 const json=createSchedulerStore(deps),sql=createSchedulerStore({...deps,storage:()=>f.state('scheduler')});json.load();sql.load();
 for(const store of [json,sql]){
  store.addTask({title:' task ',prompt:' hello ',schedule:{kind:'daily',timeOfDay:'09:00'},allowedToolIds:['a','a']});
  store.toggleTask('fixed',false);store.updateTask('fixed',{title:'changed'});
  for(let i=0;i<65;i++)store.recordHistory({id:'h'+i,taskId:'fixed',firedAt:new Date(1700000000000+i*1000).toISOString(),status:'success'});
 }
 assert.deepEqual(sql.getTasks(),json.getTasks());assert.deepEqual(sql.getHistory('fixed',100),json.getHistory('fixed',100));assert.equal(sql.getHistory('fixed',100).length,50);
 let fail=true;const storage=f.state('scheduler');const retry=createSchedulerStore({...deps,storage:()=>({...storage,set:(k,v)=>{if(fail)throw Error('WRITE_FAILED');storage.set(k,v);}})});retry.load();
 assert.throws(()=>retry.deleteTask('fixed'),/WRITE_FAILED/);assert.equal(retry.getTasks().length,1);fail=false;assert(retry.deleteTask('fixed'));assert.equal(retry.getTasks().length,0);
});

test('an existing main import receipt does not skip the new background migration',async t=>{
 const f=await fixture(t);let o=f.start();importServices(profile,o.call);await f.stop();
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.join(formal.selection(profile).data,'cyrene.sqlite'));
 db.exec("DELETE FROM life_background_import; DELETE FROM life_service_state WHERE namespace IN ('scheduler','moments-policy','moments-reactions'); DELETE FROM life_service_namespaces WHERE name IN ('scheduler','moments-policy','moments-reactions');");db.close();
 put('moments-state.json',{recentEventKeys:['upgrade']});
 o=f.start();assert(o.call('services.importReceipt').complete);importServices(profile,o.call);
 assert(o.call('services.backgroundReceipt').complete);assert.deepEqual(policy.loadMomentsPolicyState().recentEventKeys,['upgrade']);
});

test('reaction decision is durable before effects; failed acknowledgement retries without new model decision',async t=>{
 const f=await fixture(t);let o=f.start();importServices(profile,o.call);let decisions=0,effects=0,fail=false;
 const storage={read:()=>f.state('moments-reactions').get('state'),write:value=>{if(fail)throw Error('WRITE_FAILED');f.state('moments-reactions').set('state',value);}};
 const executor={decide:async()=>{decisions++;return {type:'decided',decision:{action:'like'}};},apply:async()=>{effects++;fail=true;}};
 let q=createReactionQueue({filePath:path.join(profile,'must-not-write.json'),storage,executor,now:()=>1000});
 q.enqueue({kind:'post_eval',actor:'cyrene',postId:'p',dueAt:1000});assert.equal(q.enqueue({kind:'post_eval',actor:'cyrene',postId:'p'}),null);
 await q.drainOnce();assert.equal(q.list().length,1);assert.deepEqual(q.list()[0].resolvedDecision,{action:'like'});assert.equal(decisions,1);
 await f.stop();o=f.start();fail=false;
 q=createReactionQueue({filePath:path.join(profile,'must-not-write.json'),storage,executor:{decide:executor.decide,apply:async()=>{effects++;}},now:()=>1000});
 await q.drainOnce();assert.equal(decisions,1);assert.equal(effects,2);assert.equal(q.list().length,0);assert(!fs.existsSync(path.join(profile,'must-not-write.json')));
 fail=true;assert.throws(()=>q.enqueue({kind:'auto_like',actor:'a',postId:'p'}),/WRITE_FAILED/);assert.equal(q.list().length,0);
 fail=false;assert(q.enqueue({kind:'auto_like',actor:'a',postId:'p'}));
});
