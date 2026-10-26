const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.SQLITE_TEST_RUNTIME,stage=process.env.SQLITE_TEST_ROOT;
const {migrate,options,selection}=require(path.join(runtime,'formal-storage.cjs'));
async function fixture(t){
 const profile=fs.mkdtempSync(path.join(stage,'journal-'));
 fs.mkdirSync(path.join(profile,'cyrene-chats/sessions'),{recursive:true});fs.writeFileSync(path.join(profile,'cyrene-chats/index.json'),'[]');
 fs.mkdirSync(path.join(profile,'plugin-data/companion-memory'),{recursive:true});
 fs.mkdirSync(path.join(profile,'plugin-data/companion-chat'),{recursive:true});
 fs.writeFileSync(path.join(profile,'plugin-data/companion-memory/memory-state.json'),JSON.stringify({turns:[],processed:[],l2:[]}));
 await migrate(profile,runtime);let owner;
 const start=()=>{owner=require(path.join(runtime,'bridge.cjs'))(options(profile,runtime));owner.start();return owner;};
 t.after(async()=>{await owner?.stop();fs.rmSync(profile,{recursive:true,force:true});});
 return {start,stop:()=>owner.stop(),file:path.join(selection(profile).data,'cyrene.sqlite')};
}
test('usage preserves incomplete model breakdown, batch rollback and replay across restart',async t=>{
 const f=await fixture(t);let o=f.start();
 const original={schemaVersion:2,extra:{keep:true},days:{'2026-01-01':{input:900,output:70,requests:8,hit:40,miss:860,extra:'total',models:{a:{input:10,output:3,requests:1,hit:0,miss:10,extra:'model'}}}}};
 o.call('services.seed','usage',{state:original});assert.deepEqual(o.call('services.get','usage','state'),original);
 const op={id:'u1',day:'2026-01-01',kind:'usage',args:[20,5,1,7,'a',2]};o.call('services.usageBatch','usage',[op]);
 const after=o.call('services.get','usage','state');assert.equal(after.days['2026-01-01'].input,920);assert.equal(after.days['2026-01-01'].models.a.input,30);assert.equal(after.days['2026-01-01'].extra,'total');
 assert.throws(()=>o.call('services.usageBatch','usage',[{...op,id:'u2'},{...op,kind:'request'}]),/CONFLICT/);assert.deepEqual(o.call('services.get','usage','state'),after);
 await f.stop();o=f.start();o.call('services.usageBatch','usage',[op]);assert.deepEqual(o.call('services.get','usage','state'),after);
 o.call('services.usageClear','usage');o.call('services.usageBatch','usage',[op]);assert.deepEqual(o.call('services.get','usage','state').days,{});
});
test('moments compare-before-write is atomic and media cleanup survives restart',async t=>{
 const f=await fixture(t);let o=f.start();const post={id:'p',text:'original',unknown:{a:1}},state={schemaVersion:2,posts:[post],comments:[],reactions:[],extra:true};
 o.call('services.seed','moments',{state});assert.deepEqual(o.call('services.get','moments','state'),state);
 const deletion={kind:'posts',key:'p',before:JSON.stringify(post),value:null};
 assert.throws(()=>o.call('services.momentsApply','moments',{id:'fail',changes:[deletion,{kind:'posts',key:'missing',before:'bad',value:null}]}),/CONFLICT/);
 assert.deepEqual(o.call('services.get','moments','state'),state);assert.deepEqual(o.call('services.momentsCleanup','moments'),[]);
 o.call('services.momentsReserve','moments','abandoned');o.call('services.momentsApply','moments',{id:'delete',changes:[deletion]});
 await f.stop();o=f.start();assert.deepEqual(o.call('services.momentsCleanup','moments').sort(),['abandoned','p']);
 o.call('services.momentsApply','moments',{id:'delete',changes:[deletion]});assert.equal(o.call('services.get','moments','state').posts.length,0);
});
test('only checkpointed tool results settle receipts; failed transaction rolls back both',async t=>{
 const f=await fixture(t);let o=f.start();const s=o.store.createSession({mode:'work'}),scope=`${s.id}:r`,outcome={status:'succeeded',output:'done'};
 for(const id of ['r:a','r:b']){o.call('tools.begin',scope,id,'fp');o.call('tools.finish',scope,id,'fp',outcome,true);}
 const checkpoint={schemaVersion:1,runId:'r',conversationId:s.id,status:'running',toolCalls:[],messages:[{role:'tool',toolCallId:'a',content:'done'}]};
 assert.throws(()=>o.call('harness.commit',checkpoint,undefined));
 assert.equal(o.call('harness.get','r'),null);assert.equal(o.call('services.exportLedger').find(r=>r.operation_id==='r:a').status,'ready');
 o.call('harness.commit',checkpoint,{type:'checkpoint',at:1});
 await f.stop();o=f.start();assert.deepEqual(o.call('tools.begin',scope,'r:a','fp'),{outcome});assert.throws(()=>o.call('tools.begin',scope,'r:b','fp'),/UNKNOWN/);
 assert.deepEqual(o.call('harness.get','r').messages,checkpoint.messages);
});
test('bound channel shares desktop text, atomic conflicts, edits, deletion and last-16 projection',async t=>{
 const f=await fixture(t);let o=f.start();o.call('services.seed','channel-history',{});
 const s=o.store.createSession({mode:'chat'});
 const input=i=>({conversationId:s.id,entry:{id:'user:'+i,role:'user',at:String(i)},message:{id:'m'+i,role:'user',content:'text '+i,modelContext:'group '+i,at:i+1}});
 for(let i=0;i<20;i++)o.call('services.historyBind','channel-history','channel',input(i));
 assert.deepEqual(o.call('services.historyRecent','channel-history','channel',16).map(m=>m.content),Array.from({length:16},(_,i)=>'group '+(i+4)));
 o.call('services.historyBind','channel-history','channel',input(19));assert.equal(o.store.getSession(s.id).messages.length,20);
 assert.throws(()=>o.call('services.historyBind','channel-history','channel',{...input(19),message:{...input(19).message,content:'changed'}}),/CONFLICT/);
 o.call('services.historyAppend','channel-history','channel',{id:'user:20',role:'user',content:'conflict',at:'20'});
 assert.throws(()=>o.call('services.historyBind','channel-history','channel',input(20)),/CONFLICT/);assert.equal(o.store.getSession(s.id).messages.length,20);
 o.call('life.mutate',s.id,'edit','upsertMessage',{...input(19).message,content:'edited',modelContext:'edited group'});
 assert.equal(o.call('services.historyRecent','channel-history','channel',2)[0].content,'edited group');
 o.call('life.mutate',s.id,'delete','deleteMessageRound',{messageId:'m19'});o.call('services.historyBind','channel-history','channel',input(19));assert.equal(o.store.getSession(s.id).messages.length,19);
 await f.stop();o=f.start();assert.equal(o.call('services.historyRecent','channel-history','channel',100).some(m=>m.id==='user:19'),false);
 await f.stop();const db=new DatabaseSync(f.file,{readOnly:true});try{assert.equal(JSON.parse(db.prepare("SELECT value_json FROM life_channel_entries WHERE session_id='channel' AND entry_id='user:0'").get().value_json).content,undefined);}finally{db.close();}
});
