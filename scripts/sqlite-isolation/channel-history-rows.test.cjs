const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const runtime=process.env.SQLITE_TEST_RUNTIME,stage=process.env.SQLITE_TEST_ROOT;
const {migrate,options,selection}=require(path.join(runtime,'formal-storage.cjs'));
async function fixture(t){
 const profile=fs.mkdtempSync(path.join(stage,'rows-'));
 fs.mkdirSync(path.join(profile,'cyrene-chats/sessions'),{recursive:true});fs.writeFileSync(path.join(profile,'cyrene-chats/index.json'),'[]');
 for(const id of ['companion-memory','companion-chat'])fs.mkdirSync(path.join(profile,'plugin-data',id),{recursive:true});
 fs.writeFileSync(path.join(profile,'plugin-data/companion-memory/memory-state.json'),JSON.stringify({turns:[],processed:[],l2:[]}));
 await migrate(profile,runtime);let owner;
 const start=()=>{owner=require(path.join(runtime,'bridge.cjs'))(options(profile,runtime));owner.start();return owner;};
 t.after(async()=>{await owner?.stop();fs.rmSync(profile,{recursive:true,force:true});});
 return {profile,start,stop:()=>owner.stop(),file:path.join(selection(profile).data,'cyrene.sqlite')};
}
test('legacy row migration is atomic on malformed data and retries after repair',async t=>{
 const f=await fixture(t);let owner=f.start();const good=[{role:'user',content:'kept',at:'2026-01-01',extra:{nested:true}}];
 owner.call('services.seed','channel-history',{a:good,b:[{role:'invalid',content:'bad'}]});
 assert.throws(()=>owner.call('services.historyRecent','channel-history','a',16),/INVALID/);await f.stop();
 const db=new DatabaseSync(f.file);
 try{
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM life_channel_entries').get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM life_service_state WHERE namespace='channel-history'").get().n,2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM life_service_migrations WHERE id='channel-rows-v1'").get().n,0);
  db.prepare("UPDATE life_service_state SET value_json='[]' WHERE namespace='channel-history' AND key='b'").run();
 }finally{db.close();}
 owner=f.start();assert.deepEqual(owner.call('services.historyRecent','channel-history','a',16),[{...good[0],id:'legacy:0'}]);await f.stop();
 owner=f.start();assert.equal(owner.call('services.historyRecent','channel-history','a',16).length,1);
});
test('large history keeps exact last-16 order, deduplicates by role/id and copies atomically',async t=>{
 const f=await fixture(t),owner=f.start();const entries=Array.from({length:1000},(_,i)=>({id:'user:'+i,role:'user',content:'row '+i,at:String(i)}));
 owner.call('services.seed','channel-history',{large:entries});
 assert.deepEqual(owner.call('services.historyRecent','channel-history','large',16),entries.slice(-16));
 owner.call('services.historyAppend','channel-history','large',{...entries[999],at:'changed'});
 assert.throws(()=>owner.call('services.historyAppend','channel-history','large',{...entries[999],content:'conflict'}),/CONFLICT/);
 owner.call('services.historyAppend','channel-history','large',{id:'assistant:999',role:'assistant',content:'answer',at:'now'});
 owner.call('services.historyCopy','channel-history','large','copied');owner.call('services.historyCopy','channel-history','large','copied');
 const all=owner.call('services.all','channel-history');assert.equal(all.large.length,1001);assert.deepEqual(all.copied,all.large);
 await f.stop();const db=new DatabaseSync(f.file,{readOnly:true});try{assert.equal(db.prepare("SELECT COUNT(*) AS n FROM life_service_state WHERE namespace='channel-history'").get().n,0);}finally{db.close();}
});
