const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const runtime=process.env.SQLITE_TEST_RUNTIME,stage=process.env.SQLITE_TEST_ROOT;if(!runtime||!stage)throw Error('isolated paths required');
const formal=require(path.join(runtime,'formal-storage.cjs')),{importServices}=require(path.join(runtime,'startup-service-import.cjs')),retirement=require(path.join(runtime,'legacy-retirement.cjs'));
const put=(root,name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
const run=(id,scope='default')=>({schemaVersion:1,runId:id,conversationId:scope,status:'running',messages:[{role:'user',content:'synthetic'}],toolCalls:[],toolOutputs:[],state:{todoItems:[],uncertainEffects:[]},rounds:0,request:{},cache:{cacheEpoch:1,epochReason:'run_start'},createdAt:1,updatedAt:1});
async function fixture(t,setup=()=>{}){const profile=fs.mkdtempSync(path.join(stage,'sql-only-'));let owner;setup(profile);await formal.migrate(profile,runtime);t.after(async()=>{await owner?.stop();fs.rmSync(profile,{recursive:true,force:true});});return {profile,start(){owner=require(path.join(runtime,'bridge.cjs'))(formal.options(profile,runtime));owner.start();return owner;},stop:()=>owner.stop()};}

test('headless scopes persist without visible chats; restart and deletion retain journal semantics',async t=>{
 const f=await fixture(t);let o=f.start();importServices(f.profile,o.call);const before=o.store.listSessions();
 o.call('harness.commit',run('orphan'),{type:'created',at:1});assert.deepEqual(o.store.listSessions(),before);assert.equal(o.store.getSession('default'),null);
 assert.throws(()=>o.call('harness.commit',run('orphan','other'),{type:'created',at:1}),/CONFLICT/);assert.equal(o.call('harness.get','orphan').conversationId,'default');
 await f.stop();o=f.start();assert.equal(o.call('harness.get','orphan').messages[0].content,'synthetic');
 o.call('harness.delete','default');assert.equal(o.call('harness.get','orphan'),null);assert.deepEqual(o.call('harness.audit','orphan'),[]);
 const c=o.store.createSession({mode:'work'});o.store.deleteSession(c.id);assert.throws(()=>o.call('harness.commit',run('deleted',c.id),{type:'created',at:1}),/DELETED/);assert(!fs.existsSync(path.join(f.profile,'cyrene-runs')));
});

test('late legacy runs import once; conflicts stay authoritative and sources are not cleaned',async t=>{
 const f=await fixture(t);let o=f.start();o.call('harness.commit',run('conflict'),{type:'created',at:1});
 put(f.profile,'cyrene-runs/sessions/late.json',run('late','headless'));
 put(f.profile,'cyrene-runs/sessions/conflict.json',{...run('conflict'),messages:[]});
 importServices(f.profile,o.call);assert.equal(o.call('harness.get','late').status,'interrupted');assert.equal(o.call('harness.get','conflict').messages.length,1);
 const receipt=o.call('harness.importReceipt');assert.deepEqual(receipt.imported,['late']);assert.deepEqual(receipt.retained,['conflict']);
 await f.stop();const planned=retirement.plan(f.profile);assert(planned.some(x=>x.name.endsWith('late.json')));assert(!planned.some(x=>x.name.endsWith('conflict.json')));
 fs.writeFileSync(path.join(f.profile,'cyrene-runs/sessions/late.json'),'broken');o=f.start();importServices(f.profile,o.call);assert.equal(o.call('harness.get','late').messages.length,1);await f.stop();assert.throws(()=>retirement.plan(f.profile),/LEGACY_SOURCE_CHANGED/);
});

test('validated cleanup removes only proven sources and SQL survives restart without them',async t=>{
 const f=await fixture(t);put(f.profile,'token-usage.json',{schemaVersion:2,days:{}});put(f.profile,'app-settings.json',{keep:true});put(f.profile,'memory.json',{unrelated:true});put(f.profile,'cyrene-runs/sessions/late.json',run('late'));
 let o=f.start();importServices(f.profile,o.call);await f.stop();const backup=path.join(stage,path.basename(f.profile)+'-backup');t.after(()=>fs.rmSync(backup,{recursive:true,force:true}));
 const result=retirement.retire(f.profile,backup);assert.equal(result.removed.length,2);assert(!fs.existsSync(path.join(f.profile,'token-usage.json')));assert(!fs.existsSync(path.join(f.profile,'cyrene-runs/sessions/late.json')));assert(fs.existsSync(path.join(f.profile,'memory.json')));assert(fs.existsSync(path.join(f.profile,'app-settings.json')));
 o=f.start();importServices(f.profile,o.call);assert.equal(o.call('harness.get','late').status,'interrupted');assert.deepEqual(o.call('services.get','usage','state'),{schemaVersion:2,days:{}});await f.stop();assert(!fs.existsSync(path.join(f.profile,'token-usage.json')));assert.deepEqual(retirement.plan(f.profile),[]);
});

test('malformed legacy run prevents completion and leaves every source intact',async t=>{
 const f=await fixture(t),o=f.start();put(f.profile,'cyrene-runs/sessions/bad.json',{runId:'bad'});assert.throws(()=>importServices(f.profile,o.call),/HARNESS_LEGACY_INVALID/);assert.equal(o.call('harness.importReceipt'),null);assert.equal(o.call('services.importReceipt'),null);assert(fs.existsSync(path.join(f.profile,'cyrene-runs/sessions/bad.json')));
});

test('cleanup never removes unindexed chat files merely because they were in the source snapshot',async t=>{
 const f=await fixture(t,profile=>{put(profile,'cyrene-chats/index.json',[]);put(profile,'cyrene-chats/sessions/orphan.json',{id:'orphan',messages:[{content:'not indexed'}]});});
 const o=f.start();importServices(f.profile,o.call);await f.stop();const files=retirement.plan(f.profile);assert(files.some(x=>x.name==='cyrene-chats/index.json'));assert(!files.some(x=>x.name.includes('orphan.json')));
});
