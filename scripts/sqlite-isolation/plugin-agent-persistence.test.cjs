const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.SQLITE_TEST_RUNTIME,stage=process.env.SQLITE_TEST_ROOT;
const {migrate,options,selection}=require(path.join(runtime,'formal-storage.cjs'));
async function fixture(t){
 const profile=fs.mkdtempSync(path.join(stage,'agent-'));let owner;
 t.after(async()=>{await owner?.stop();fs.rmSync(profile,{recursive:true,force:true});});
 for(const [name,value]of Object.entries({'cyrene-chats/index.json':[],'plugin-data/companion-memory/memory-state.json':{turns:[],processed:[],l2:[]},'plugin-data/companion-chat/chat-state.json':{}})){
  const file=path.join(profile,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));
 }
 fs.mkdirSync(path.join(profile,'cyrene-chats/sessions'));await migrate(profile,runtime);
 return {profile,file:path.join(selection(profile).data,'cyrene.sqlite'),start(){owner=require(path.join(runtime,'bridge.cjs'))(options(profile,runtime));owner.start();return owner;},stop:()=>owner.stop()};
}
const scope=p=>'plugin-agent:'+JSON.stringify([p,'r']),outcome={status:'succeeded',output:'done'};
const checkpoint={messages:[{role:'tool',toolCallId:'t',content:'done'}],state:{todoItems:[],uncertainEffects:[]},rounds:1};
const result={text:'done',terminal:{status:'completed',reason:'final_answer',externalEffectsMayContinue:false},rounds:1};
test('plugin result and tool receipt commit together; restart/rollback/reimport deduplicate',async t=>{
 const f=await fixture(t);let o=f.start();const contract={goal:'fixture'},fp=crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
 o.call('pluginAgent.begin','p','r',fp);assert.throws(()=>o.call('pluginAgent.begin','p','r',fp),/ACTIVE/);
 o.call('tools.begin',scope('p'),'r:t','tool');o.call('tools.finish',scope('p'),'r:t','tool',outcome,true);
 assert.throws(()=>o.call('pluginAgent.complete','p','r',fp,result),/NOT_COMMITTED/);
 o.call('pluginAgent.checkpoint','p','r',fp,checkpoint);o.call('pluginAgent.complete','p','r',fp,result);
 assert.throws(()=>o.call('pluginAgent.begin','p','r','different'),/CONFLICT/);assert.deepEqual(o.call('pluginAgent.begin','other','r','other'),{});
 await f.stop();o=f.start();assert.deepEqual(o.call('pluginAgent.begin','p','r',fp),{result});assert.throws(()=>o.call('pluginAgent.begin','other','r','other'),/INTERRUPTED/);
 const rows=o.call('pluginAgent.export');assert.deepEqual(JSON.parse(rows.find(r=>r.plugin_id==='p').checkpoint_json),checkpoint);await f.stop();
 const rolled=await require(path.join(runtime,'rollback-storage.cjs')).rollback(f.profile,runtime);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rolled.profile,'plugin-agent-runs.json'))),rows);
 await migrate(rolled.profile,runtime);const restored=require(path.join(runtime,'bridge.cjs'))(options(rolled.profile,runtime));
 try{restored.start();assert.deepEqual(restored.call('pluginAgent.begin','p','r',fp),{result});}finally{await restored.stop();}
});
test('failed receipt update rolls back the checkpoint; restart blocks uncertain replay',async t=>{
 const f=await fixture(t);f.start();await f.stop();
 const db=new DatabaseSync(f.file);db.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON tool_operations WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'TEST_COMMIT_FAILURE'); END");db.close();
 let o=f.start();o.call('pluginAgent.begin','p','r','fp');o.call('tools.begin',scope('p'),'r:t','tool');o.call('tools.finish',scope('p'),'r:t','tool',outcome,true);
 assert.throws(()=>o.call('pluginAgent.checkpoint','p','r','fp',checkpoint),/ERR_SQLITE_ERROR/);
 assert.equal(o.call('pluginAgent.export')[0].checkpoint_json,null);assert.equal(o.call('services.exportLedger')[0].status,'ready');
 await f.stop();o=f.start();assert.throws(()=>o.call('pluginAgent.begin','p','r','fp'),/INTERRUPTED/);assert.throws(()=>o.call('tools.begin',scope('p'),'r:t','tool'),/UNKNOWN/);
});
