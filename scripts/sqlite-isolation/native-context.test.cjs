const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const runtime=process.env.SQLITE_TEST_RUNTIME,stage=process.env.SQLITE_TEST_ROOT,compiled=process.env.SQLITE_TEST_COMPILED,baseline=process.env.SQLITE_TEST_BASELINE;
if(!runtime||!stage||!compiled||!baseline)throw Error('isolated paths and pre-migration baseline required');
let profile;const originalLoad=Module._load;Module._load=function(id,...args){if(id==='electron')return {app:{getPath:()=>profile}};return originalLoad.call(this,id,...args);};
const current=name=>require(path.join(compiled,'main',name+'.js')),old=name=>require(path.join(baseline,'main',name+'.js'));
const formal=require(path.join(runtime,'formal-storage.cjs')),{importServices}=require(path.join(runtime,'startup-service-import.cjs'));
const put=(name,value)=>fs.writeFileSync(path.join(profile,name),JSON.stringify(value));
async function fixture(t){profile=fs.mkdtempSync(path.join(stage,'context-'));await formal.migrate(profile,runtime);let owner;
 const start=()=>{owner=require(path.join(runtime,'bridge.cjs'))(formal.options(profile,runtime));owner.start();return owner;};
 const state=ns=>({get:key=>owner.call('services.get',ns,key),set:(key,value)=>owner.call('services.set',ns,key,value)});
 current('storage/service-state').setServiceStateProvider((_root,ns)=>state(ns));
 t.after(async()=>{await owner?.stop();fs.rmSync(profile,{recursive:true,force:true});});return {start,state,stop:()=>owner.stop()};}
const atom=(id,patch={})=>({id,conversationId:'c',type:'short_term',content:'乌龙茶计划 '+id,evidenceTurnId:'u'+id,evidenceQuote:'乌龙茶',createdAt:100,status:'active',...patch});

test('context import is atomic, field preserving, restart safe and independent of companion storage',async t=>{
 const f=await fixture(t);let o=f.start();
 assert.throws(()=>o.call('services.importContext',{bundle:{'native-call-context':{state:[]}},sources:{}}),/CONTEXT_IMPORT_NAMESPACE_MISSING/);
 assert.equal(o.call('services.initialized','native-call-context'),false);
 put('proactive-state.json',[]);assert.throws(()=>importServices(profile,o.call),/CONTEXT_IMPORT_INVALID/);assert.equal(o.call('services.contextReceipt'),null);
 put('phone-context-events.json',[{id:'a',startedAt:1,endedAt:2,summary:'电话',extra:5}]);put('chat-social-atoms.json',{schemaVersion:1,atoms:[atom('a')],extra:7});put('relationship-log.json',{entries:[],dailySummaries:[],extra:9});put('proactive-state.json',{unansweredCount:1,extra:11});
 const companion=o.pluginStorage('companion-chat').get('chat-state');importServices(profile,o.call);
 assert.equal(f.state('native-social').get('state').extra,7);assert.equal(f.state('native-relationship').get('state').extra,9);assert.equal(f.state('native-proactive').get('state').extra,11);
 assert.deepEqual(o.pluginStorage('companion-chat').get('chat-state'),companion);
 for(const name of ['phone-context-events.json','chat-social-atoms.json','relationship-log.json','proactive-state.json'])fs.unlinkSync(path.join(profile,name));
 await f.stop();o=f.start();importServices(profile,o.call);assert.equal(current('call/call-context-store').loadCallContextEvents()[0].extra,5);assert.equal(current('proactive/proactive-state-store').loadProactiveState().unansweredCount,1);assert(!fs.existsSync(path.join(profile,'proactive-state.json')));
});

test('call ordering, 100-item window and model-visible text match pre-migration JSON',async t=>{
 const f=await fixture(t),o=f.start();const events=Array.from({length:105},(_,i)=>({id:'call'+i,startedAt:105-i,endedAt:121000+i,summary:'  通话 '+i+'  '}));events.push({bad:true});put('phone-context-events.json',events);importServices(profile,o.call);
 const a=old('call/call-context-store'),b=current('call/call-context-store');assert.deepEqual(b.loadCallContextEvents(),a.loadCallContextEvents());assert.equal(b.loadCallContextEvents().length,100);
 assert.deepEqual(b.loadCallContextEvents().map(b.formatCallContextEvent),a.loadCallContextEvents().map(a.formatCallContextEvent));
 const input={startedAt:999,endedAt:9999,summary:' 描述'.repeat(800)};const x=a.saveCallContextEvent(input),y=b.saveCallContextEvent(input);assert.deepEqual({...x,id:''},{...y,id:''});assert.equal(y.summary.length,1200);
});

test('social expiry, updates, retrieval and prompt text match; failed SQL write is retryable',async t=>{
 const f=await fixture(t),o=f.start();const atoms=[atom('a'),atom('loop',{type:'open_loop'}),atom('expired',{expiresAt:200}),atom('other',{conversationId:'other'})];put('chat-social-atoms.json',{schemaVersion:1,atoms});importServices(profile,o.call);
 const a=old('social-context/store').createSocialAtomStore(path.join(profile,'chat-social-atoms.json'));let fail=false;const storage=f.state('native-social');const b=current('social-context/store').createSocialAtomStore(undefined,()=>({...storage,set:(k,v)=>{if(fail)throw Error('WRITE_FAILED');storage.set(k,v);}}));
 const ops=[{operation:'supersede',targetAtomId:'a',atom:atom('new')},{operation:'resolve',targetAtomId:'loop',evidenceTurnId:'new-turn',evidenceQuote:'完成'}];
 a.applyOperations('c',ops,200);fail=true;assert.throws(()=>b.applyOperations('c',ops,200),/WRITE_FAILED/);assert.equal(b.getById('a').status,'active');fail=false;b.applyOperations('c',ops,200);b.applyOperations('c',ops,200);
 assert.deepEqual(b.listActive('c',200),a.listActive('c',200));assert.equal(b.getById('loop').resolvedByTurnId,'new-turn');
 for(const query of ['乌龙茶','计划','无关的火星地质']){const x=old('social-context/retrieval').rankSocialAtoms(query,a.listActive('c',200),{now:200}),y=current('social-context/retrieval').rankSocialAtoms(query,b.listActive('c',200),{now:200});assert.deepEqual(y,x);assert.equal(current('social-context/context').compileSocialContextBlock(y),old('social-context/context').compileSocialContextBlock(x));}
});

test('relationship retention and model-visible context match pre-migration JSON',async t=>{
 const f=await fixture(t),o=f.start();importServices(profile,o.call);const a=new (old('relationship/relationship-log').RelationshipLogStore)(path.join(profile,'relationship-log.json')),b=new (current('relationship/relationship-log').RelationshipLogStore)();
 const now=Date.now,random=Math.random;Math.random=()=>0.25;
 try{for(let i=0;i<505;i++){Date.now=()=>Date.UTC(2026,0,1)+i*86400000;const input={userText:i%2?'今天开心':'今天很累',assistantText:'陪你休息',cyreneFeeling:'温柔',channel:'desktop'};assert.deepEqual(await b.recordTurn(input),await a.recordTurn(input));}}finally{Date.now=now;Math.random=random;}
 assert.equal(await b.buildContext(),await a.buildContext());const data=f.state('native-relationship').get('state');assert.equal(data.entries.length,500);assert.equal(data.dailySummaries.length,90);
});

test('20 proactive state/policy/prompt scenarios match and failed persistence leaves committed state intact',async t=>{
 const f=await fixture(t);let o=f.start();importServices(profile,o.call);const a=old('proactive/proactive-state-store'),b=current('proactive/proactive-state-store');
 for(let i=0;i<20;i++){
  const raw={unansweredCount:i%3,lastProactiveAt:1700000000000-i*3600000,globalDesire:i*5,affinity:{work_break:i},lastFiredAt:{work_break:1699990000000},extra:'kept'};put('proactive-state.json',raw);f.state('native-proactive').set('state',raw);const x=a.loadProactiveState(),y=b.loadProactiveState();assert.deepEqual(y,x);
  const snapshot={now:1700000000000,localHour:i%2?14:23,idleSec:i*20,enabled:true,conversationBusy:false,generationBusy:false,screenLocked:false},candidate={sceneId:'work_break',score:90,sceneCooldownMs:7200000};
  assert.deepEqual(current('proactive/proactive-policy').canStartProactiveGeneration(snapshot,y,candidate),old('proactive/proactive-policy').canStartProactiveGeneration(snapshot,x,candidate));
  const args=state=>({basePersona:'P',ordinaryHistory:[],proactiveHistory:[],sceneId:'work_break',localNow:new Date(snapshot.now),idleSec:snapshot.idleSec,unansweredCount:state.unansweredCount,timezone:'Asia/Shanghai'});
  assert.deepEqual(current('proactive/proactive-prompt').buildProactiveMessages(args(y)),old('proactive/proactive-prompt').buildProactiveMessages(args(x)));
 }
 const committed=b.loadProactiveState();current('storage/service-state').setServiceStateProvider((_root,ns)=>({...f.state(ns),set:()=>{throw Error('WRITE_FAILED');}}));assert.throws(()=>b.saveProactiveState({...committed,unansweredCount:0}),/WRITE_FAILED/);assert.deepEqual(b.loadProactiveState(),committed);
 current('storage/service-state').setServiceStateProvider((_root,ns)=>f.state(ns));b.saveProactiveState({...committed,unansweredCount:0});await f.stop();o=f.start();assert.equal(b.loadProactiveState().unansweredCount,0);
});
