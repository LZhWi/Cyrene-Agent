const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const runtime=process.env.SQLITE_TEST_RUNTIME,stage=process.env.SQLITE_TEST_ROOT,compiled=process.env.SQLITE_TEST_COMPILED;
if(!runtime||!stage||!compiled)throw Error('isolated runtime, root and compiled main required');
const formal=require(path.join(runtime,'formal-storage.cjs'));
const {harnessRunScope}=require(path.join(compiled,'main/orchestrator/harness/run-scope.js'));
const run=(id,scope=harnessRunScope(undefined,id))=>({schemaVersion:1,runId:id,conversationId:scope,status:'running',messages:[],toolCalls:[],toolOutputs:[],state:{todoItems:[],uncertainEffects:[]},rounds:0,request:{},cache:{cacheEpoch:1,epochReason:'run_start'},createdAt:1,updatedAt:1});

test('headless scopes coexist; visible scope conflicts are actionable and atomic across the bridge',async t=>{
 const profile=fs.mkdtempSync(path.join(stage,'scope-'));let owner;
 t.after(async()=>{await owner?.stop();fs.rmSync(profile,{recursive:true,force:true});});
 await formal.migrate(profile,runtime);
 const start=()=>{owner=require(path.join(runtime,'bridge.cjs'))(formal.options(profile,runtime));owner.start();return owner;};
 let o=start();const before=o.store.listSessions();
 for(const id of ['one','two'])o.call('harness.commit',run(id),{type:'created',at:1});
 assert.deepEqual(o.store.listSessions(),before);
 const c=o.store.createSession({mode:'work'});
 o.call('harness.commit',run('visible-one',c.id),{type:'created',at:1});
 assert.throws(()=>o.call('harness.commit',run('visible-two',c.id),{type:'created',at:1}),/HARNESS_SCOPE_BUSY:.*等待/);
 assert.equal(o.call('harness.get','visible-two'),null);
 assert.deepEqual(o.call('harness.audit','visible-two'),[]);
 o.call('harness.commit',{...run('visible-one',c.id),status:'completed'},{type:'completed',at:2});
 o.call('harness.commit',run('visible-two',c.id),{type:'created',at:3});
 await o.stop();o=start();
 for(const id of ['one','two'])assert.equal(o.call('harness.get',id).conversationId,harnessRunScope(undefined,id));
 assert.equal(o.store.listSessions().length,before.length+1);
 assert.equal(o.call('harness.audit','visible-two').length,1);
 assert(!fs.existsSync(path.join(profile,'cyrene-runs')));
});
