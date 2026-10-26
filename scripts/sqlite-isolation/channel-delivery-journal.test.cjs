const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.SQLITE_TEST_RUNTIME,stage=process.env.SQLITE_TEST_ROOT;
const {migrate,options,selection}=require(path.join(runtime,'formal-storage.cjs'));
async function fixture(t){
 const profile=fs.mkdtempSync(path.join(stage,'delivery-'));let owner;
 t.after(async()=>{await owner?.stop();fs.rmSync(profile,{recursive:true,force:true});});
 for(const [name,value]of Object.entries({'cyrene-chats/index.json':[],'plugin-data/companion-memory/memory-state.json':{turns:[],processed:[],l2:[]},'plugin-data/companion-chat/chat-state.json':{}})){
  const file=path.join(profile,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));
 }
 fs.mkdirSync(path.join(profile,'cyrene-chats/sessions'));await migrate(profile,runtime);
 return {profile,file:path.join(selection(profile).data,'cyrene.sqlite'),start(){owner=require(path.join(runtime,'bridge.cjs'))(options(profile,runtime));owner.start();return owner;},stop:()=>owner.stop()};
}
const saved=conversationId=>({status:'delivered',fingerprint:'fp',incoming:{channel:'qq',chatId:'g',messageId:'m',senderId:'u',chatType:'group',senderName:'name',at:'2026-01-01T00:00:00Z'},context:{sessionId:'channel:qq:fixture',boundConversationId:conversationId},prepared:{assistantText:'answer',stickerId:'hug'},at:1,extra:{preserved:true}});
test('legacy receipts migrate losslessly; bound message/link/receipt commit and restart idempotently',async t=>{
 const f=await fixture(t);let o=f.start();const s=o.store.createSession({mode:'chat'}),value=saved(s.id);
 o.call('services.seed','channel-history',{});o.call('services.seed','channel-delivery',{key:value});
 assert.deepEqual(o.call('services.get','channel-delivery','key'),value);
 o.call('services.deliveryCommit','channel-delivery','key');assert.equal(o.store.getSession(s.id).messages.length,1);
 const message=o.store.getSession(s.id).messages[0];assert.equal(message.content,'answer');assert.equal(message.sticker,'hug');
 assert.equal(o.call('services.get','channel-delivery','key').status,'committed');
 await f.stop();o=f.start();o.call('services.deliveryCommit','channel-delivery','key');assert.equal(o.store.getSession(s.id).messages.length,1);
 o.call('life.mutate',s.id,'delete','deleteMessageRound',{messageId:message.id});o.call('services.deliveryCommit','channel-delivery','key');
 assert.equal(o.store.getSession(s.id).messages.length,0);assert.deepEqual(o.call('services.historyRecent','channel-history','channel_qq_fixture',16),[]);
 await f.stop();const db=new DatabaseSync(f.file,{readOnly:true});try{const link=db.prepare('SELECT * FROM life_channel_deliveries WHERE receipt_id=?').get('key');assert.equal(link.entry_id,'assistant:m');assert.equal(link.session_id,'channel_qq_fixture');assert.equal(db.prepare("SELECT COUNT(*) AS n FROM life_service_state WHERE namespace='channel-delivery'").get().n,0);}finally{db.close();}
});
test('receipt update failure rolls back the desktop message and channel entry together',async t=>{
 const f=await fixture(t);let o=f.start();const s=o.store.createSession({mode:'chat'});
 o.call('services.seed','channel-history',{});o.call('services.seed','channel-delivery',{key:saved(s.id)});o.call('services.get','channel-delivery','key');await f.stop();
 let db=new DatabaseSync(f.file);db.exec("CREATE TRIGGER reject_delivery BEFORE UPDATE ON life_channel_deliveries WHEN json_extract(NEW.value_json,'$.status')='committed' BEGIN SELECT RAISE(ABORT,'TEST_FAILURE'); END");db.close();
 o=f.start();assert.throws(()=>o.call('services.deliveryCommit','channel-delivery','key'),/ERR_SQLITE_ERROR/);
 assert.equal(o.store.getSession(s.id).messages.length,0);assert.deepEqual(o.call('services.historyRecent','channel-history','channel_qq_fixture',16),[]);assert.equal(o.call('services.get','channel-delivery','key').status,'delivered');
 await f.stop();db=new DatabaseSync(f.file);db.exec('DROP TRIGGER reject_delivery');db.close();
 o=f.start();o.call('services.deliveryCommit','channel-delivery','key');assert.equal(o.store.getSession(s.id).messages.length,1);
});
test('unconfirmed delivery never enters history; confirmed independent history is committed once',async t=>{
 const f=await fixture(t),o=f.start();o.call('services.seed','channel-history',{});o.call('services.seed','channel-delivery',{});
 const value={...saved(null),status:'sending'};o.call('services.set','channel-delivery','key',value);
 assert.throws(()=>o.call('services.deliveryCommit','channel-delivery','key'),/NOT_CONFIRMED/);
 assert.throws(()=>o.call('services.set','channel-delivery','key',{...value,context:{sessionId:'other'}}),/CONTEXT_CONFLICT/);
 o.call('services.set','channel-delivery','key',{...value,status:'delivered'});o.call('services.deliveryCommit','channel-delivery','key');o.call('services.deliveryCommit','channel-delivery','key');
 assert.equal(o.call('services.historyRecent','channel-history','channel_qq_fixture',16).length,1);
 assert.throws(()=>o.call('services.set','channel-delivery','key',value),/TRANSITION_INVALID/);
});
test('legacy operation payload compaction retains replay and conflict protection',async t=>{
 const f=await fixture(t);let o=f.start();
 o.call('services.seed','usage',{state:{schemaVersion:2,days:{}}});o.call('services.seed','moments',{state:{schemaVersion:2,posts:[],comments:[],reactions:[]}});
 const usage={id:'u',day:'2026-01-01',kind:'usage',args:[20,3,1,0,'model',0]};
 const moment={id:'m',changes:[{kind:'posts',key:'p',before:null,value:JSON.stringify({id:'p',text:'x'.repeat(10000)}),seq:0}]};
 o.call('services.usageBatch','usage',[usage]);o.call('services.momentsApply','moments',moment);
 const before=o.call('services.export');await f.stop();let db=new DatabaseSync(f.file);
 try{
  for(const [table,op]of [['life_usage_operations',usage],['life_moment_operations',moment]]){
   db.prepare(`UPDATE ${table} SET input_json=? WHERE id=?`).run(JSON.stringify(op),op.id);
   db.prepare('DELETE FROM life_service_migrations WHERE id=?').run(table+'-digests-v1');
  }
 }finally{db.close();}
 o=f.start();assert.deepEqual(o.call('services.export'),before);
 o.call('services.usageBatch','usage',[usage]);o.call('services.momentsApply','moments',moment);
 assert.throws(()=>o.call('services.usageBatch','usage',[{...usage,args:[1]}]),/CONFLICT/);
 assert.throws(()=>o.call('services.momentsApply','moments',{...moment,changes:[]}),/CONFLICT/);
 assert.deepEqual(o.call('services.export'),before);await f.stop();db=new DatabaseSync(f.file,{readOnly:true});
 try{for(const table of ['life_usage_operations','life_moment_operations']){const row=db.prepare(`SELECT input_json FROM ${table}`).get();assert.match(row.input_json,/^sha256:[a-f0-9]{64}$/);assert.equal(row.input_json.length,71);}}finally{db.close();}
});
