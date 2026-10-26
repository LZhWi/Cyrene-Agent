const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const support=process.env.SQLITE_TEST_RUNTIME;if(!support)throw Error('SQLITE_TEST_RUNTIME required');
const formal=require(path.join(support,'formal-storage.cjs')),create=require(path.join(support,'bridge.cjs'));
async function fixture(t){const profile=fs.mkdtempSync(path.join(os.tmpdir(),'sqlite-response-'));let owner;t.after(async()=>{try{if(owner)await owner.stop();}finally{fs.rmSync(profile,{recursive:true,force:true});}});
 for(const [name,value]of Object.entries({'cyrene-chats/index.json':[],'plugin-data/companion-memory/memory-state.json':{turns:[],processed:[],entries:[]},'plugin-data/companion-chat/chat-state.json':{sessions:[]}})){const file=path.join(profile,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));}fs.mkdirSync(path.join(profile,'cyrene-chats/sessions'));
 await formal.migrate(profile,support);owner=create(formal.options(profile,support));owner.start();return {owner,profile};
}
test('responses above 32 MiB preserve data, execute the mutation once, and leave the owner usable',async t=>{
 const {owner}=await fixture(t),content='x'.repeat(34*1024*1024);
 const session=owner.store.createSession({mode:'chat',title:'large response',initialMessages:[{id:'large',role:'user',content,at:1},{id:'tail',role:'model',content:'tail',at:2}]});
 assert.equal(session.messages[0].content,content);assert.equal(owner.store.listSessions().length,1);
 const page=owner.store.getSessionPage(session.id,null,1);assert.equal(page.messages.length,1);assert.equal(page.messages[0].content,'tail');assert.equal(page.session.messageCount,2);assert.equal(page.hasMore,true);
 assert.equal(owner.store.getSession(session.id).messages[0].content,content);
 owner.store.renameSession(session.id,'still healthy');assert.equal(owner.store.listSessions()[0].title,'still healthy');
});
test('worker pagination preserves JSON bounds, order and metadata without calling the bridge full-session getter',async t=>{
 const {owner}=await fixture(t),session=owner.store.createSession({mode:'chat',title:'pages',initialMessages:Array.from({length:205},(_,i)=>({id:String(i),role:i%2?'model':'user',content:'message '+i,at:i+1}))});
 const whole=owner.store.getSession(session.id);owner.store.getSession=()=>{throw Error('Full session must not cross the bridge for paging');};
 for(const [before,limit]of [[null,16],[4,2],[0,5],[-1,5],[999,999],[100,0],[8,2.8]]){const end=Math.max(0,Math.min(before??whole.messages.length,whole.messages.length)),start=Math.max(0,end-Math.max(1,Math.min(Math.floor(limit)||1,200))),{messages,...meta}=whole;
 assert.deepEqual(owner.store.getSessionPage(session.id,before,limit),{session:{...meta,messageCount:messages.length},messages:messages.slice(start,end),hasMore:start>0});}
 assert.equal(owner.store.getSessionPage('missing',null,10),null);
});
