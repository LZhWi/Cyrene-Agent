const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const support=process.env.SQLITE_TEST_RUNTIME;if(!support)throw Error('SQLITE_TEST_RUNTIME required');
const formal=require(path.join(support,'formal-storage.cjs')),create=require(path.join(support,'bridge.cjs'));
async function fixture(t){const profile=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-parity-'));let owner;
 t.after(async()=>{try{await owner?.stop();}finally{fs.rmSync(profile,{recursive:true,force:true});}});
 for(const [name,value]of Object.entries({'cyrene-chats/index.json':[],'plugin-data/companion-memory/memory-state.json':{turns:[],processed:[],entries:[]},'plugin-data/companion-chat/chat-state.json':{sessions:[]}})){const file=path.join(profile,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));}fs.mkdirSync(path.join(profile,'cyrene-chats/sessions'));
 await formal.migrate(profile,support);owner=create(formal.options(profile,support));owner.start();return {get owner(){return owner;},async restart(){await owner.stop();owner=create(formal.options(profile,support));owner.start();}};
}
const user={id:'u',role:'user',content:'question',at:1},answer={id:'a',role:'model',content:'answer',at:2};
for(const mode of ['chat','work','code','learn'])test(mode+': music events do not participate in adjacent round deletion',async t=>{
 const f=await fixture(t),store=f.owner.store,checks=[];
 for(const music of [false,true])for(const target of ['u','a']){
  const messages=[{...user,...(music?{musicEvent:{startedAt:1,tracks:[{id:'track',name:'test',artists:['test'],playedAt:1}]}}:{})},answer],s=store.createSession({mode,initialMessages:messages});
  const expected=music?[target==='u'?'a':'u']:[];
  assert.deepEqual(store.deleteMessageRound(s.id,target).messages.map(m=>m.id),expected);checks.push([s.id,expected]);
 }
 await f.restart();for(const [id,expected]of checks)assert.deepEqual(f.owner.store.getSession(id).messages.map(m=>m.id),expected);
});
test('tail replacement returns null without changes for stale IDs, invalid bounds and missing sessions',async t=>{
 const {owner}=await fixture(t),store=owner.store,s=store.createSession({mode:'chat',initialMessages:[user,answer]}),before=store.getSession(s.id);
 for(const start of [-1,0.5,3])assert.equal(store.replaceMessagesTail(s.id,start,[],['u','a']),null);
 assert.equal(store.replaceMessagesTail('missing',0,[],[]),null);
 for(const ids of [[],['u'],['a','u'],['u','wrong']])assert.equal(store.replaceMessagesTail(s.id,0,[],ids),null);
 assert.deepEqual(store.getSession(s.id),before);
 assert.equal(store.replaceMessagesTail(s.id,2,[],[]).messages.length,2);
 assert.deepEqual(store.replaceMessagesTail(s.id,0,[user],['u','a']).messages,[user]);
 assert.equal(store.replaceMessagesTail(s.id,0,[user],['u','a']),null);
 assert.deepEqual(store.replaceMessagesTail(s.id,0,[user,answer]).messages,[user,answer]);
});
test('worker checks expected tail at mutation time even when bridge has a stale snapshot',async t=>{
 const f=await fixture(t),owner=f.owner,store=owner.store,s=store.createSession({mode:'chat',initialMessages:[user,answer]});
 store.appendMessage(s.id,{id:'p',role:'model',content:'proactive arrived',at:3});
 const current=store.getSession(s.id),original=store.getSession;store.getSession=()=>s;
 try{assert.equal(store.replaceMessagesTail(s.id,0,[user],['u','a']),null);}finally{store.getSession=original;}
 assert.deepEqual(store.getSession(s.id),current);
 assert.equal(owner.call('life.mutate',s.id,'stale-direct','replaceMessagesTail',{startIndex:0,messages:[user],expectedTailIds:['u','a']}),null);
 await f.restart();assert.deepEqual(f.owner.store.getSession(s.id),current);
});

test('visual derived metadata does not invalidate sources; actual sticker edits do',async t=>{
 const f=await fixture(t),s=f.owner.store.createSession({mode:'chat',initialMessages:[{...user,attachments:[{kind:'image',name:'pic.png',filePath:'pic.png'}]},answer]});
 const events=()=>f.owner.call('life.pendingEvents').filter(row=>row.event.type==='host:conversation:changed');
 f.owner.store.setImageVisualIndexResult(s.id,'u','pic.png',{caption:'full description',summary:'short summary',indexedAt:5});
 assert.equal(events().length,0);
 const messages=f.owner.store.getSession(s.id).messages;
 f.owner.store.replaceMessagesTail(s.id,0,[{...messages[0],sticker:'hugtight'},messages[1]],['u','a']);
 assert.deepEqual(events().at(-1).event.invalidatedMessageIds,['u']);
 f.owner.store.deleteMessageRound(s.id,'u');
 assert.equal(f.owner.store.setImageVisualIndexResult(s.id,'u','pic.png',{caption:'late',summary:'late',indexedAt:6}),false);
 await f.restart();assert.equal(f.owner.store.getSession(s.id).messages.length,0);
});
