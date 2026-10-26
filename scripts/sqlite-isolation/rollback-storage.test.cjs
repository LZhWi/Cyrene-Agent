const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const support=process.env.SQLITE_TEST_RUNTIME;if(!support)throw Error('SQLITE_TEST_RUNTIME required');
const formal=require(path.join(support,'formal-storage.cjs')),{rollback,resolveRollbackData}=require(path.join(support,'rollback-storage.cjs')),create=require(path.join(support,'bridge.cjs'));
async function fixture(t){const profile=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-rollback-'));t.after(()=>fs.rmSync(profile,{recursive:true,force:true}));
 const put=(name,value)=>{const file=path.join(profile,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
 put('cyrene-chats/index.json',[]);fs.mkdirSync(path.join(profile,'cyrene-chats/sessions'));
 put('plugin-data/companion-memory/memory-state.json',{turns:[],processed:[],l2:[]});put('plugin-data/companion-chat/chat-state.json',{sessions:[]});put('app-settings.json',{unchanged:true});
 await formal.migrate(profile,support);const owner=create(formal.options(profile,support));let id;
 try{owner.start();const session=owner.store.createSession({mode:'chat',title:'new after SQLite'});id=session.id;
  owner.store.appendMessage(id,{id:'new-message',role:'user',content:'new after SQLite',at:100,sticker:'test',attachments:[{kind:'image',name:'stable.png',filePath:'stable.png',visualIndexSummary:'图片摘要',visualIndexCaption:'full description',visualIndexedAt:100}]});
  const storage=owner.pluginStorage('companion-memory');storage.set('memory-state',{turns:[],processed:[],l2:[{id:'new-memory',content:'new memory'}]});storage.set('vector-index',{newVector:[0.2,0.8]});storage.set('isolated-sqlite-pending-owner',{version:1});
  owner.call('harness.commit',{schemaVersion:1,conversationId:id,runId:'new-run',status:'completed',messages:[],toolCalls:[],createdAt:100,updatedAt:101},{at:101,type:'completed'});
 }finally{await owner.stop();}return {profile,id};
}
test('rollback preserves new messages, attachment metadata, memory, vectors, runs and other files',async t=>{
 const {profile,id}=await fixture(t),before=formal.inventory(profile),result=await rollback(profile,support),target=resolveRollbackData(profile);
 assert.equal(target,result.profile);assert.equal(formal.selection(target),undefined);assert.deepEqual(formal.inventory(profile),before);
 const read=name=>JSON.parse(fs.readFileSync(path.join(target,name)));
 assert.equal(read('cyrene-chats/sessions/'+id+'.json').messages[0].attachments[0].visualIndexSummary,'图片摘要');
 assert.equal(read('plugin-data/companion-memory/memory-state.json').l2[0].id,'new-memory');assert.deepEqual(read('plugin-data/companion-memory/vector-index.json').newVector,[0.2,0.8]);
 assert.equal(read('cyrene-runs/sessions/new-run.json').status,'completed');assert.match(fs.readFileSync(path.join(target,'cyrene-runs/sessions/new-run.events.jsonl'),'utf8'),/completed/);
 assert.deepEqual(read('app-settings.json'),{unchanged:true});assert(!fs.existsSync(path.join(target,'plugin-data/companion-memory/isolated-sqlite-pending-owner.json')));
 assert.equal((await rollback(profile,support)).unchanged,true);
 await formal.migrate(target,support);assert(formal.selection(target));
});
for(const phase of ['snapshot','export','verified','intent','activated'])test('process interruption at rollback '+phase+' retains data and permits retry',async t=>{
 const {profile,id}=await fixture(t),{spawnSync}=require('child_process');
 const script="require(process.argv[1]).rollback(process.argv[2],process.argv[3],{point:p=>{if(p===process.argv[4])process.exit(72)}}).catch(e=>{console.error(e);process.exit(1)})";
 const child=spawnSync(process.execPath,['-e',script,path.join(support,'rollback-storage.cjs'),profile,support,phase],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(child.status,72,child.stderr);
 if(phase==='intent')assert.throws(()=>resolveRollbackData(profile),/INCOMPLETE/);else assert.equal(resolveRollbackData(profile)===profile,phase!=='activated');
 await rollback(profile,support);const target=resolveRollbackData(profile);assert.equal(JSON.parse(fs.readFileSync(path.join(target,'cyrene-chats/sessions',id+'.json'))).messages[0].content,'new after SQLite');
});
for(const key of ['isolated-native-prompt-receipts','sqlite-extraction-retry-state'])test('rollback refuses unsettled '+key,async t=>{
 const {profile}=await fixture(t),owner=create(formal.options(profile,support));try{owner.start();owner.pluginStorage('companion-memory').set(key,key.includes('receipts')?{pending:[{runId:'pending'}]}:{pending:{attempts:1}});}finally{await owner.stop();}
 await assert.rejects(rollback(profile,support),/SQLITE_ROLLBACK_PENDING/);assert.equal(resolveRollbackData(profile),profile);
});
test('changed source rejects interrupted rollback completion',async t=>{const {profile}=await fixture(t);await assert.rejects(rollback(profile,support,{point:p=>{if(p==='intent')throw Error('stop');}}));fs.writeFileSync(path.join(profile,'changed.json'),'{}');await assert.rejects(rollback(profile,support),/SOURCE_CHANGED/);assert.throws(()=>resolveRollbackData(profile),/INCOMPLETE/);});
test('corrupted export manifest blocks interrupted completion',async t=>{const {profile}=await fixture(t);await assert.rejects(rollback(profile,support,{point:p=>{if(p==='intent')throw Error('stop');}}));const control=path.join(profile,'.sqlite-storage'),intent=JSON.parse(fs.readFileSync(path.join(control,'rollback-intent.json')));fs.writeFileSync(path.join(control,'rollbacks',intent.id,'files.json'),'[]');await assert.rejects(rollback(profile,support),/MANIFEST_CHANGED/);});
test('deleted SQL session does not resurrect stale JSON recovery files',async t=>{const {profile,id}=await fixture(t),owner=create(formal.options(profile,support));try{owner.start();owner.store.deleteSession(id);for(const event of owner.call('life.pendingEvents'))owner.call('life.ackEvent',event.id);}finally{await owner.stop();}const stale=path.join(profile,'cyrene-chats/sessions',id+'.last-good.json');fs.writeFileSync(stale,JSON.stringify({id,messages:[{id:'old'}]}));const result=await rollback(profile,support);assert(!fs.existsSync(path.join(result.profile,'cyrene-chats/sessions',id+'.json')));assert(!fs.existsSync(path.join(result.profile,'cyrene-chats/sessions',id+'.last-good.json')));assert.deepEqual(JSON.parse(fs.readFileSync(path.join(result.profile,'cyrene-chats/index.last-good.json'))),[]);});
