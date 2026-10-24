// Isolation-only persistence owner. It never instantiates memory, retrieval or subscribers.
const {parentPort,workerData}=require('worker_threads'),fs=require('fs'),path=require('path'),crypto=require('crypto'),{isDeepStrictEqual}=require('util');
const {DatabaseSync}=require('node:sqlite');
const {ConversationDatabaseClient}=require(path.join(workerData.runtime,'upstream/src/main/storage/conversation-database-client.js'));
const root=path.resolve(workerData.data),base=fs.realpathSync(workerData.runtime);
if(!root.startsWith(base+path.sep))throw Error('JOINT_ISOLATION_REQUIRED');
const read=p=>JSON.parse(fs.readFileSync(p)),digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)??'undefined').digest('hex');
let client,lock,aggregate,checkpointStore,databaseFailure,epoch,projectionHash,tail=Promise.resolve(),closed=false;
const file=path.join(root,'unified/plugin-state.json'),report={commands:[],conflicts:[],businessOwners:'actual-loaded-plugins-only'};
// Diagnostics must not break RPC settlement after a committed transaction.
const saveReport=()=>{try{fs.writeFileSync(workerData.report,JSON.stringify(report,null,2));}catch{report.diagnosticWriteFailures=(report.diagnosticWriteFailures||0)+1;}};
function persist(value,writes){const saved=checkpointStore.commitKeys(value,writes);aggregate=saved.aggregate;}
async function start(){
 checkpointStore=require('./pair-checkpoint.cjs').createCheckpointStore({isolationRoot:path.dirname(base),root});
 fs.mkdirSync(root,{recursive:true});if(fs.realpathSync(root)!==root)throw Error('JOINT_PATH_REDIRECTION');
 lock=new DatabaseSync(path.join(root,'runtime-owner.sqlite'));lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
 const fresh=!fs.existsSync(path.join(root,'cyrene.sqlite'));
 if(fresh)fs.cpSync(path.join(workerData.snapshot,'cyrene-chats'),path.join(root,'cyrene-chats'),{recursive:true});
 if(fresh&&fs.existsSync(path.join(workerData.snapshot,'cyrene-runs')))fs.cpSync(path.join(workerData.snapshot,'cyrene-runs'),path.join(root,'cyrene-runs'),{recursive:true});
 client=new ConversationDatabaseClient(root,error=>{databaseFailure=error;parentPort.postMessage({kind:'fatal',error:error.message});});
 const sessions=await client.call('chats.listSessions');for(const s of sessions)await client.call('transcript.read',s.id);
 if(fresh){
  const values=id=>Object.fromEntries(fs.readdirSync(path.join(workerData.snapshot,'plugin-data',id)).filter(f=>f.endsWith('.json')&&!f.endsWith('.last-good.json')).map(f=>[f.slice(0,-5),read(path.join(workerData.snapshot,'plugin-data',id,f))]));
  aggregate={version:1,values:{'companion-memory':values('companion-memory'),'companion-chat':values('companion-chat')}};
  const memory=aggregate.values['companion-memory']['memory-state'];report.boundSources=[];
  for(const turn of memory.turns){
   if(turn.origin==='companion-chat'){
    Object.assign(turn,require('./private-sources.cjs').bindPrivateTurn(aggregate.values['companion-chat']['chat-state'],turn));
    await client.call('life.bindPrivateSource',turn);report.privateTurnsBound=(report.privateTurnsBound||0)+1;continue;
   }
   const session=await client.call('chats.getSession',turn.sessionId),u=session?.messages.find(m=>m.id===turn.inputMessageId),a=session?.messages.find(m=>m.id===turn.finalMessageId);
   if(!u||!a||u.role!=='user'||a.role!=='model'||u.content!==turn.user||a.content!==turn.assistant||u.at!==turn.userAt||a.at!==turn.assistantAt)throw Error('JOINT_SOURCE_BINDING_NOT_EXACT');
   const source=await client.call('life.memorySource',turn.sessionId,turn.inputMessageId);
   if(!source?.userEntryId||!source?.assistantEntryId)throw Error('JOINT_SOURCE_MISSING');
   turn.hostSourceVersion=source;report.boundSources.push({hash:digest(turn.id),processed:memory.processed.includes(turn.id)});
  }
  const saved=checkpointStore.initialize(aggregate);aggregate=saved.aggregate;if(saved.projectionError)report.projectionError=saved.projectionError;
 }else {
  aggregate=checkpointStore.read().aggregate;
  try{checkpointStore.verifyProjection();}catch(error){if(!/^PAIR_PROJECTION_/.test(error.message))throw error;report.projectionRecovered=error.message;checkpointStore.repairProjection();}
 }
 projectionHash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 epoch=crypto.randomUUID();await client.call('life.beginProactiveEpoch',epoch);
 report.ready={state:'idle',sessions:sessions.length};saveReport();return report.ready;
}
async function execute(method,args){
 if(databaseFailure)throw databaseFailure;if(method==='start')return start();if(closed)throw Error('JOINT_OWNER_STOPPED');
 if(method==='call'){
  if(args[0]==='life.memorySource'&&args[1]?.startsWith('private:companion-chat:')){
   const sessionId=args[1].slice('private:companion-chat:'.length),messages=aggregate.values['companion-chat']['chat-state']?.sessions?.find(s=>s.id===sessionId)?.messages;
   const index=messages?.findIndex(m=>m.id===args[2]&&m.role==='user')??-1,user=messages?.[index],assistant=messages?.[index+1];
   if(!user||!assistant)return null;
   try{
    const current=require('./private-sources.cjs').bindPrivateTurn(aggregate.values['companion-chat']['chat-state'],{id:user.id,sessionId,origin:'companion-chat',user:user.text,assistant:assistant.text,userAt:user.at,assistantAt:assistant.at}).hostSourceVersion;
    return isDeepStrictEqual(current,await client.call(...args))?current:null;
   }catch(error){if(error.message==='PRIVATE_SOURCE_MISMATCH')return null;throw error;}
  }
  if(args[0]==='private.bindTurn'){
   const turn=require('./private-sources.cjs').bindPrivateTurn(aggregate.values['companion-chat']['chat-state'],args[1]);
   await client.call('life.bindPrivateSource',turn);return turn;
  }
  if(['memory.current','memory.consume'].includes(args[0])){
   const rows=args[0]==='memory.current'?args[1]:args[1]?.turns;
   for(const row of rows??[])if(row.pluginTurn?.origin==='companion-chat'){
    try{const bound=require('./private-sources.cjs').bindPrivateTurn(aggregate.values['companion-chat']['chat-state'],row.pluginTurn);
     if(!isDeepStrictEqual(bound.hostSourceVersion,row.pluginTurn.hostSourceVersion))return false;
    }catch{return false;}
   }
  }
  return client.call(...args);
 }
 if(method==='recoveryIssues'){
  // A deferred projection is expected after key-level commits. Recovery approval
  // validates SQL authority; this listing never offers deleting that authority.
  return fs.existsSync(file)&&crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')===projectionHash?[]:[{file,canRestore:true}];
 }
 if(method==='approveRecovery'){
  const [target,isolate]=args;if(target!==file||isolate)throw Error('JOINT_RECOVERY_TARGET_REJECTED');
  checkpointStore.read();
  if(fs.existsSync(file)&&crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')===projectionHash)throw Error('JOINT_NO_RECOVERY_ISSUE');
  if(fs.existsSync(file))fs.copyFileSync(file,file+'.recovery-'+crypto.randomUUID());
  checkpointStore.repairProjection();projectionHash=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');return;
 }
 if(method==='beginProactiveRun')return client.call('life.beginProactiveRun',args[0],epoch);
 if(method==='sealProactiveRun')return client.call('life.sealProactiveRun',args[0],epoch);
 if(method==='get'){const [id,key]=args,v=aggregate.values[id][key];return {value:v,hash:digest(v)};}
 if(method==='set'){
  const [id,key,value,expected]=args;if(digest(aggregate.values[id][key])!==expected){report.conflicts.push({id,key});saveReport();throw Error('JOINT_STALE_PLUGIN_STATE:'+key);}
  const candidate={...aggregate,values:{...aggregate.values,[id]:{...aggregate.values[id],[key]:value}}};persist(candidate,[{pluginId:id,key}]);return digest(value);
 }
 if(method==='setMany'){
  const [id,writes,guard]=args;
  if(guard!==undefined&&(!guard||typeof guard!=='object'||Array.isArray(guard)))throw Error('JOINT_PROMPT_SOURCE_STALE');
  if(guard?.proactiveTerminal){
   const expected=guard.proactiveTerminal,current=await client.call('life.proactiveLifecycle',expected.runId);
   if(!['companion-chat','companion-memory'].includes(id)||!['delivered','invalidated','abandoned'].includes(expected.state)||!isDeepStrictEqual(current,expected))throw Error('JOINT_PROACTIVE_TERMINAL_CHANGED');
  }
  else if(guard?.promptTerminal){
   const expected=guard.promptTerminal,current=await client.call('life.promptLifecycle',expected.conversationId,expected.runId);
   if(!['companion-chat','companion-memory'].includes(id)||expected.state!=='terminal'||!isDeepStrictEqual(current,expected))throw Error('JOINT_PROMPT_TERMINAL_CHANGED');
  }
  else if(guard&&Object.prototype.hasOwnProperty.call(guard,'proactiveSourceAbsent')){
   if(!['companion-chat','companion-memory'].includes(id)||typeof guard.proactiveSourceAbsent!=='string'||!guard.proactiveSourceAbsent||(await client.call('life.proactiveReceiptExists',guard.proactiveSourceAbsent))!==false)throw Error('JOINT_PROACTIVE_SOURCE_EXISTS');
   if((await client.call('life.proactiveLifecycle',guard.proactiveSourceAbsent)).state==='abandoned')throw Error('JOINT_PROACTIVE_RUN_SEALED');
  }
  else if(guard?.proactiveSource){
   const source=guard.proactiveSource,keys=['runId','pluginId','conversationId','messageId','assistantEntryId','status','deliveredAt'];
   if(!['companion-chat','companion-memory'].includes(id)||source.pluginId!=='companion-chat'||source.status!=='delivered'||keys.some(key=>source[key]===undefined)||!source.assistantEntryId)throw Error('JOINT_PROACTIVE_SOURCE_STALE');
   const current=await client.call('life.proactiveReceiptSource',source.runId);
   if(!current||keys.some(key=>current[key]!==source[key]))throw Error('JOINT_PROACTIVE_SOURCE_STALE');
  }
  else if(guard?.memorySources){
   if(!Array.isArray(guard.memorySources)||!guard.memorySources.length)throw Error('JOINT_EXTRACTION_SOURCE_STALE');
   // These are immutable transcript versions, not queue rows (which also require seq).
   for(const source of guard.memorySources){
    if(source.conversationId?.startsWith('private:companion-chat:')){
     const turn=aggregate.values[id]['memory-state']?.turns?.find(t=>t.hostSourceVersion?.conversationId===source.conversationId&&t.hostSourceVersion?.userTurnId===source.userTurnId);
     const bound=require('./private-sources.cjs').bindPrivateTurn(aggregate.values['companion-chat']['chat-state'],turn);
     if(!isDeepStrictEqual(bound.hostSourceVersion,source))throw Error('JOINT_EXTRACTION_SOURCE_STALE');
    }
    const current=await client.call('life.memorySource',source.conversationId,source.userTurnId);
    if(!current||['conversationId','userTurnId','userEntryId','assistantEntryId'].some(key=>current[key]!==source[key]))throw Error('JOINT_EXTRACTION_SOURCE_STALE');}
  }
  else if(guard){const current=await client.call('life.promptSource',guard.conversationId,guard.runId);
   if(!current||!['prepared','running','completed'].includes(current.status)||(current.status==='completed'&&!current.assistantEntryId)||!isDeepStrictEqual(current,guard))throw Error('JOINT_PROMPT_SOURCE_STALE');
  }
  const values={...aggregate.values[id]},hashes={};
  for(const {key,value,expected}of writes){if(digest(values[key])!==expected)throw Error('JOINT_STALE_PLUGIN_STATE:'+key);values[key]=value;hashes[key]=digest(value);}
  if(writes.length)persist({...aggregate,values:{...aggregate.values,[id]:values}},writes.map(({key})=>({pluginId:id,key})));return hashes;
 }
 if(method==='backup')return checkpointStore.backup(args[0]);
 if(method==='stop'){try{await client?.close();}finally{if(lock){lock.exec('ROLLBACK');lock.close();}closed=true;}report.stopped=true;saveReport();return true;}
 throw Error('JOINT_UNKNOWN_COMMAND:'+method);
}
parentPort.on('message',msg=>{if(msg.kind==='embedding-stats'){report.embeddingIdentity=msg.identity;report.embeddingCalls=msg.calls;saveReport();return;}tail=tail.then(async()=>{
 const startedAt=Date.now(),name=msg.method==='call'?msg.args[0]:msg.method;
 report.inFlight={requestId:msg.requestId,name,startedAt,key:['get','set'].includes(msg.method)?msg.args[1]:undefined};saveReport();
 let result;try{result={value:await execute(msg.method,msg.args)};}catch(e){result={error:String(e.stack)};report.error=String(e.stack);}
 (report.timings??=[]).push({...report.inFlight,elapsedMs:Date.now()-startedAt,error:!!result.error});delete report.inFlight;
 report.commands.push(msg.method==='call'?msg.args[0]:msg.method);saveReport();
 parentPort.postMessage({requestId:msg.requestId,...result});
}).catch(error=>{setImmediate(()=>{throw error;});});});
