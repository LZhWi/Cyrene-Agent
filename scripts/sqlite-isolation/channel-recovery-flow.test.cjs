const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const stage=process.env.SQLITE_TEST_ROOT,runtime=process.env.SQLITE_TEST_RUNTIME,compiled=process.env.SQLITE_TEST_COMPILED;
if(!stage||!runtime||!compiled)throw Error('Isolated paths required');
let profile,owner,fault='';const original=Module._load;
Module._load=function(id,parent,...rest){if(id==='electron')return {app:{getPath:()=>profile}};return original.call(this,id,parent,...rest);};
const mod=name=>require(path.join(compiled,'main',name));
test('dispatcher persistence faults, owner restart, startup diagnostics and shutdown drain',async t=>{
 profile=fs.mkdtempSync(path.join(stage,'profile-'));
 t.after(async()=>{await owner?.stop();mod('storage/service-state.js').setServiceStateProvider(undefined);fs.rmSync(profile,{recursive:true,force:true});});
 for(const [name,value] of Object.entries({'cyrene-chats/index.json':[],'plugin-data/companion-memory/memory-state.json':{turns:[],processed:[],l2:[]},'plugin-data/companion-chat/chat-state.json':{}})){const f=path.join(profile,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(value));}
 fs.mkdirSync(path.join(profile,'cyrene-chats/sessions'));
 const {migrate,options}=require(path.join(runtime,'formal-storage.cjs'));await migrate(profile,runtime);
 const start=()=>{owner=require(path.join(runtime,'bridge.cjs'))(options(profile,runtime));owner.start();};start();
 mod('storage/service-state.js').setServiceStateProvider((_root,ns,seed)=>{
  if(!owner.call('services.initialized',ns))owner.call('services.seed',ns,seed());
  return {get:key=>owner.call('services.get',ns,key),all:()=>owner.call('services.all',ns),set:(key,value)=>{if(fault==='delivered'&&value.status==='delivered')throw Error('AFTER_SEND_BEFORE_RECEIPT');return owner.call('services.set',ns,key,value);},call:(method,...args)=>{if(fault==='commit'&&method==='services.deliveryCommit')throw Error('BEFORE_HISTORY_COMMIT');return owner.call(method,...args);}};
 });
 const history=mod('channels/history-log.js'),receipt=mod('channels/durable-delivery.js'),logs=mod('channels/message-log.js');
 let sends=0,generations=0,cleanups=0,release,started;let sendGate;
 const context={resolveDispatchContext:()=>({sessionId:'channel:qq:recovery',boundConversationId:null}),recordIncomingSession(){},resolvePriorMessages:async()=>history.loadRecentHistory('channel:qq:recovery',16),appendIncomingContext:async()=>{},appendAssistantContext:async()=>{throw Error('NON_ATOMIC_COMMIT');}};
 const dispatcher=new (mod('channels/dispatcher.js').ChannelDispatcher)({context,queue:mod('channels/keyed-queue.js').createKeyedQueue(),limiter:mod('channels/rate-limiter.js').createChannelRateLimiter({limits:{perUser:100,perChannel:100}}),loadSettings:()=>({rateLimitPerUser:100,rateLimitPerChannel:100,mirrorToDesktop:false}),loadGeneralSettings:()=>({}),buildAndRunAgent:async(_msg,_session,prior)=>{generations++;assert(!JSON.stringify(prior).includes('回执'));return {text:'answer',sticker:null};},composer:{compose:async()=>({assistantText:'answer',message:{targetId:'g',parts:[{kind:'text',text:'answer'}]},transientFiles:[]}),cleanupTransientFiles:async()=>{cleanups++;}},delivery:{send:async()=>{sends++;started?.();await sendGate;return {ok:true};}}});
 const msg=id=>({channel:'qq',chatId:'g',senderId:'u',text:'question',messageId:id,at:new Date('2026-10-26T00:00:00Z')});
 fault='delivered';await assert.rejects(dispatcher.handleIncoming(msg('uncertain')),/AFTER_SEND/);
 assert.equal(receipt.channelReceipt(msg('uncertain')).saved.status,'sending');assert.equal(sends,1);assert.equal(cleanups,1);
 await owner.stop();start();fault='';await receipt.recoverDeliveredChannelReceipts(context);
 assert(logs.getRecentLog().some(e=>e.dir==='error'&&e.text.includes('发送回执待核对')));
 await dispatcher.handleIncoming(msg('uncertain'));assert.equal(sends,1);assert.equal(generations,1);assert.equal(history.loadRecentHistory('channel:qq:recovery',16).length,0);
 fault='commit';await assert.rejects(dispatcher.handleIncoming(msg('confirmed')),/BEFORE_HISTORY/);
 assert.equal(receipt.channelReceipt(msg('confirmed')).saved.status,'delivered');
 await receipt.recoverDeliveredChannelReceipts(context);assert(logs.getRecentLog().some(e=>e.text.includes('历史待恢复')));
 await owner.stop();start();fault='';await receipt.recoverDeliveredChannelReceipts(context);await receipt.recoverDeliveredChannelReceipts(context);
 await dispatcher.handleIncoming(msg('confirmed'));assert.equal(sends,2);assert.equal(generations,2);assert.equal(history.loadRecentHistory('channel:qq:recovery',16).length,1);
 const manager=new (mod('channels/manager.js').ChannelManager)();let stopped=false;
 const adapter={id:'qq',displayName:'isolated',onMessage:null,capability:{},start:async()=>{},stop:async()=>{stopped=true;},getStatus:()=>({enabled:true,phase:'running'}),send:async()=>{throw Error('NETWORK_FORBIDDEN');}};
 manager.register(adapter);manager.setDispatcher(m=>dispatcher.handleIncoming(m));await manager.startAll();
 sendGate=new Promise(resolve=>{release=resolve;});const entered=new Promise(resolve=>{started=resolve;});
 const pending=adapter.onMessage(msg('shutdown'));await entered;const closing=manager.stopAll();
 assert.equal(stopped,false);assert.equal(await adapter.onMessage(msg('rejected-after-shutdown')),null);release();await Promise.all([pending,closing]);assert.equal(stopped,true);assert.equal(receipt.channelReceipt(msg('shutdown')).saved.status,'committed');
 await owner.stop();start();await receipt.recoverDeliveredChannelReceipts(context);await dispatcher.handleIncoming(msg('shutdown'));
 assert.equal(sends,3);assert.equal(generations,3);assert.equal(cleanups,3);assert.equal(history.loadRecentHistory('channel:qq:recovery',16).length,2);
 assert(history.loadRecentHistory('channel:qq:recovery',16).every(e=>e.content==='answer'));
 // Exit the entire host process without closing its SQLite owner at both crash boundaries.
 await owner.stop();
 for(const phase of ['sending','delivered']){
  const child=require('node:child_process').spawnSync(process.execPath,['-e',`
   const fs=require('fs'),path=require('path'),Module=require('module');const original=Module._load;
   const profile=process.env.CRASH_PROFILE,runtime=process.env.SQLITE_TEST_RUNTIME,compiled=process.env.SQLITE_TEST_COMPILED;
   Module._load=function(id,...rest){return id==='electron'?{app:{getPath:()=>profile}}:original.call(this,id,...rest);};
   const {options}=require(path.join(runtime,'formal-storage.cjs'));const o=require(path.join(runtime,'bridge.cjs'))(options(profile,runtime));o.start();
   require(path.join(compiled,'main/storage/service-state.js')).setServiceStateProvider((_r,ns)=>({get:k=>o.call('services.get',ns,k),all:()=>o.call('services.all',ns),set:(k,v)=>o.call('services.set',ns,k,v)}));
   const phase=process.env.CRASH_PHASE,msg={channel:'qq',chatId:'g',senderId:'u',text:'question',messageId:'crash-'+phase,at:new Date('2026-10-26T00:00:00Z')};
   const receipt=require(path.join(compiled,'main/channels/durable-delivery.js')).channelReceipt(msg);
   const metadata={context:{sessionId:'channel:qq:recovery',boundConversationId:null},prepared:{assistantText:'crash-answer'}};
   receipt.write({status:'sending',...metadata});
   fs.appendFileSync(path.join(profile,'synthetic-external-sends.txt'),phase+'\\n');
   if(phase==='delivered')receipt.write({status:'delivered',...metadata});
   process.exit(73);
  `],{env:{...process.env,CRASH_PROFILE:profile,CRASH_PHASE:phase},encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(child.status,73,child.stderr);
 }
 start();await receipt.recoverDeliveredChannelReceipts(context);
 assert.equal(receipt.channelReceipt(msg('crash-sending')).saved.status,'sending');
 assert.equal(receipt.channelReceipt(msg('crash-delivered')).saved.status,'committed');
 await dispatcher.handleIncoming(msg('crash-sending'));await dispatcher.handleIncoming(msg('crash-delivered'));
 assert.equal(sends,3);assert.equal(generations,3);
 assert.equal(fs.readFileSync(path.join(profile,'synthetic-external-sends.txt'),'utf8'),'sending\ndelivered\n');
 assert.equal(history.loadRecentHistory('channel:qq:recovery',16).filter(e=>e.content==='crash-answer').length,1);
});
