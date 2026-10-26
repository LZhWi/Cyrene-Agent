const {Worker}=require('worker_threads'),path=require('path'),v8=require('v8'),crypto=require('crypto'),fs=require('fs');
module.exports=function createBridge(options){
 const control=new Int32Array(new SharedArrayBuffer(8));
 const worker=new Worker(path.join(__dirname,'supervisor.cjs'),{workerData:{...options,control:control.buffer}});worker.unref();let stopped=false,stopping,terminalError,terminationRequested=false;
 let markTerminated;const terminated=new Promise(resolve=>{markTerminated=resolve;});
 const pending=new Map(),controllers=new Map(),storages=new Map();let sequence=0;
 const failWorker=error=>{terminalError??=error instanceof Error?error:Error(String(error));for(const p of pending.values())p.reject(terminalError);pending.clear();};
 const assertRunning=()=>{if(!terminalError&&Atomics.load(control,0)===1)failWorker(Error('JOINT_OWNER_TERMINATED_UNKNOWN_OUTCOME'));if(terminalError)throw terminalError;};
 const abort=error=>{Atomics.store(control,0,1);failWorker(error);try{worker.postMessage({method:'abort',error:terminalError.message});}catch{}};
 worker.on('message',r=>{if(r.kind==='terminated'){markTerminated();return;}if(r.terminal&&!r.requestId){failWorker(Error(r.error));return;}const p=pending.get(r.requestId);if(!p)return;pending.delete(r.requestId);r.error?p.reject(Error(r.error)):p.resolve(r.value);if(!pending.size&&!stopping)worker.unref();});
 worker.on('error',failWorker);
 worker.on('exit',code=>{markTerminated();if(!terminationRequested&&!stopped)failWorker(Error('JOINT_SUPERVISOR_EXIT:'+code));});
 const asyncRpc=(method,...args)=>new Promise((resolve,reject)=>{
  try{assertRunning();}catch(error){return reject(error);}if(stopped||(stopping&&method!=='stop'))return reject(Error('JOINT_OWNER_STOPPED'));
  const requestId=++sequence;pending.set(requestId,{resolve,reject});
  worker.ref();try{worker.postMessage({method,args,requestId});}catch(error){pending.delete(requestId);reject(error);if(!pending.size&&!stopping)worker.unref();}
 });
 function rpc(method,...args){
  assertRunning();if(stopped||stopping)throw Error('JOINT_OWNER_STOPPED');
  let shared=new SharedArrayBuffer(32+64*1024),head=new Int32Array(shared,0,8);
  const timeoutMs=method==='start'?(options.startTimeoutMs??180000):(options.rpcTimeoutMs??15000),deadline=performance.now()+timeoutMs+1000;
  let heartbeat=Atomics.load(control,1),aliveAt=performance.now();
  const requestId=++sequence;worker.postMessage({method,args,shared,requestId,timeoutMs});
  while(Atomics.load(head,0)!==1){
   if(Atomics.load(head,0)===2){
    const size=head[1];if(size<=0){abort(Error('JOINT_RESPONSE_UNKNOWN_OUTCOME:INVALID_SIZE'));throw terminalError;}
    try{shared=new SharedArrayBuffer(32+size);head=new Int32Array(shared,0,8);}
    catch{abort(Error('JOINT_RESPONSE_UNKNOWN_OUTCOME:ALLOCATION'));throw terminalError;}
    worker.postMessage({method:'receiveResponse',requestId,shared});
   }
   Atomics.wait(head,0,0,100);
   if(Atomics.load(head,0)===1)break;
   const now=performance.now(),next=Atomics.load(control,1);if(next!==heartbeat){heartbeat=next;aliveAt=now;}
   if(now-aliveAt>3000||now>deadline){abort(Error('JOINT_TIMEOUT_UNKNOWN_OUTCOME:'+method));throw terminalError;}
  }
  if(head[1]<0){abort(Error('JOINT_RESPONSE_UNKNOWN_OUTCOME:TOO_LARGE'));throw terminalError;}
  let result;try{result=v8.deserialize(Buffer.from(new Uint8Array(shared,32,head[1])));}catch{abort(Error('JOINT_RESPONSE_UNKNOWN_OUTCOME:INVALID'));throw terminalError;}
  if(result.terminal)failWorker(Error(result.error));if(result.error)throw Error(result.error);return result.value;
 }
 const call=(...args)=>rpc('call',...args),mutate=(id,name,args)=>call(store.getSession(id)?.mode==='chat'?'life.mutate':'life.workMutate',id,crypto.randomUUID(),name,args);
 const store={initialize(){},getRootDir:()=>options.data,getStorageRecoveryIssues:()=>rpc('recoveryIssues'),
  approveStorageRecovery:(file,isolate=false)=>rpc('approveRecovery',file,isolate),
  openStorageFolder:async()=>{const error=await require('electron').shell.openPath(options.data);if(error)throw Error(error);},
  listSessions:opts=>call('chats.listSessions',opts),getSession:id=>call('chats.getSession',id),
  getSessionPage:(id,before,limit)=>call('chats.getSessionPage',id,before,limit),
  getSessionByPurpose:purpose=>call('chats.getSessionByPurpose',purpose),
  getLatestSessionId:()=>call('chats.getLatestSessionId'),
  getWorkspaceBinding:id=>store.getSession(id)?.workspaceBinding,
  appendMessage:(id,m)=>mutate(id,'appendMessage',m),upsertMessage:(id,m)=>mutate(id,'upsertMessage',m),
  appendProactiveMessage:(id,input)=>call('life.appendProactiveMessage',id,input),
  setMessageTtsCacheKey:(id,messageId,cacheKey,converterVersion)=>mutate(id,'setMessageTtsCacheKey',{messageId,cacheKey,converterVersion}),
  setImageVisualIndexResult:(id,messageId,filePath,result)=>mutate(id,'setImageVisualIndexResult',{messageId,filePath,result}),
  markPluginMessageIgnored:(id,messageId)=>mutate(id,'markPluginMessageIgnored',{messageId}),
  deleteSession:id=>call('life.deleteSession',id),
  migrateLegacyMessages:messages=>call('chats.migrateLegacyMessages',messages),
  replaceMessages:(id,m)=>mutate(id,'replaceMessages',m),deleteMessageRound:(id,messageId)=>mutate(id,'deleteMessageRound',{messageId}),
  replaceMessagesTail:(id,startIndex,messages,expectedTailIds)=>mutate(id,'replaceMessagesTail',{startIndex,messages,expectedTailIds}),
 };
 // No implicit fallback to the formal JSON store for unknown operations.
 for(const name of ['createSession','renameSession','setSessionPinned','setSessionModelProfile','setSessionContextUsage','setWorkspaceBinding','clearWorkspaceBinding'])store[name]=(...args)=>call('chats.'+name,...args);
 store.getOrCreateSessionByPurpose=(purpose,opts)=>store.getSessionByPurpose(purpose)||store.createSession({...opts,purpose});
 const pluginStorage=id=>{
  if(storages.has(id))return storages.get(id);
  const seen=new Map(),dir=path.join(options.data,'plugin-storage',id);let transaction,transactionGuard,poisoned=false;
  fs.mkdirSync(dir,{recursive:true});
  const assertHealthy=()=>{if(poisoned)throw Error('JOINT_PLUGIN_RESTART_REQUIRED:'+id);assertRunning();};
  const get=key=>{assertHealthy();if(transaction?.has(key))return structuredClone(transaction.get(key).value);const r=rpc('get',id,key);seen.set(key,r.hash);return r.value;};
  const value={isolationAggregate:true,isolationSources:{
   async readPromptSource(conversationId,runId){assertHealthy();return asyncRpc('call','life.promptSource',conversationId,runId);},
   async readProactiveSource(runId){assertHealthy();return asyncRpc('call','life.proactiveReceiptSource',runId);},
   async beginProactiveRun(runId){assertHealthy();await asyncRpc('beginProactiveRun',runId);},
   async readProactiveLifecycle(runId){assertHealthy();return asyncRpc('call','life.proactiveLifecycle',runId);},
   async sealProactiveRun(runId){assertHealthy();return asyncRpc('sealProactiveRun',runId);},
   async readPromptLifecycle(conversationId,runId){assertHealthy();return asyncRpc('call','life.promptLifecycle',conversationId,runId);},
  },isolationTransaction:{assertHealthy,canDrain:()=>Boolean(transaction&&transactionGuard&&Object.keys(transactionGuard).length===1&&transactionGuard.proactiveSource?.status==='delivered'),run(fn,guard){
   assertHealthy();if(transaction)throw Error('JOINT_NESTED_TRANSACTION');
   if(guard!==undefined&&(!guard||typeof guard!=='object'||Array.isArray(guard)))throw Error('JOINT_PROMPT_SOURCE_STALE');
   transactionGuard=structuredClone(guard);transaction=new Map();
   try {const result=fn();if(result&&typeof result.then==='function')throw Error('JOINT_ASYNC_TRANSACTION');
    const hashes=rpc('setMany',id,[...transaction.entries()].map(([key,v])=>({key,...v})),transactionGuard);
    for(const [key,hash]of Object.entries(hashes))seen.set(key,hash);return result;
   }catch(error){poisoned=true;throw error;}finally{transaction=undefined;transactionGuard=undefined;}
  }},...(id==='companion-memory'?{isolationQueue:{call:(...args)=>{assertHealthy();return asyncRpc('call',...args);},register(controller){if(controllers.has(id))throw Error('JOINT_DUPLICATE_MEMORY_OWNER');controllers.set(id,controller);return ()=>{if(controllers.get(id)===controller)controllers.delete(id);};}}}:{}),get,set(key,value){
   assertHealthy();if(!seen.has(key))get(key);
   if(transaction){transaction.set(key,{value:structuredClone(value),expected:seen.get(key)});return;}
   seen.set(key,rpc('set',id,key,value,seen.get(key)));
  },rootDir:()=>dir};storages.set(id,value);return value;
 };
 function stop(){
  if(stopping)return stopping;if(stopped)return terminalError?Promise.reject(terminalError):Promise.resolve();
  stopping=(async()=>{
   let failure;
   try{await asyncRpc('stop');}catch(error){failure=error;}
   finally{
    if(failure)try{worker.postMessage({method:'abort',error:failure.message});}catch{}
    let timer;await Promise.race([terminated,new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);clearTimeout(timer);
    terminationRequested=true;
    try{await worker.terminate();}catch(error){failure??=error;}
    stopped=true;if(pending.size)failWorker(failure??Error('JOINT_OWNER_STOPPED'));
   }
   if(failure??terminalError)throw failure??terminalError;
  })();return stopping;
 }
 return {start:()=>rpc('start'),call,callAsync:(...args)=>asyncRpc('call',...args),exportJson:()=>asyncRpc('exportJson'),backup:destination=>asyncRpc('backup',destination),embed:texts=>asyncRpc('embed',texts),store,pluginStorage,controllers,stop};
};
