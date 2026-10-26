// This thread alone settles shared replies; it never runs storage or embedding work.
const {Worker,parentPort,workerData}=require('node:worker_threads'),path=require('node:path'),v8=require('node:v8');
const control=new Int32Array(workerData.control),requests=new Map();
let owner,embedding,stopping=false,terminalError,termination,internalId=0;
const heartbeat=setInterval(()=>Atomics.add(control,1,1),50);
function settleShared(id,request,bytes){
 requests.delete(id);clearTimeout(request.timer);
 const head=new Int32Array(request.shared,0,8),body=new Uint8Array(request.shared,32);
 body.set(bytes);head[1]=bytes.length;
 Atomics.store(head,0,1);Atomics.notify(head,0);
}
function settle(id,result){
 const request=requests.get(id);if(!request)return;
 let bytes;if(request.shared){
  try{bytes=v8.serialize(result);}catch{return fail(Error('JOINT_RESPONSE_UNKNOWN_OUTCOME:SERIALIZATION'));}
  if(bytes.length>request.shared.byteLength-32){
   // Retain the completed result; resizing must never dispatch a mutation twice.
   request.responseBytes=bytes;const head=new Int32Array(request.shared,0,8);
   head[1]=bytes.length;Atomics.store(head,0,2);Atomics.notify(head,0);return;
  }
  settleShared(id,request,bytes);return;
 }
 requests.delete(id);clearTimeout(request.timer);
 if(request.resolve){result.error?request.reject(Error(result.error)):request.resolve(result.value);return;}
 if(!request.shared){parentPort.postMessage({requestId:id,...result});return;}
}
function terminate(){
 return termination??=(async()=>{const results=await Promise.allSettled([owner,embedding].filter(Boolean).map(worker=>worker.terminate()));
  const failure=results.find(result=>result.status==='rejected');if(failure)throw failure.reason;
  clearInterval(heartbeat);parentPort.postMessage({kind:'terminated'});
 })();
}
function fail(error){
 if(terminalError)return;terminalError=String(error?.message??error);Atomics.store(control,0,1);
 for(const id of [...requests.keys()])settle(id,{error:terminalError,terminal:true});
 parentPort.postMessage({terminal:true,error:terminalError});
 void terminate().catch(error=>parentPort.postMessage({terminal:true,error:'JOINT_TERMINATION_FAILED:'+error.message}));
}
function create(file,label){
 const worker=new Worker(path.join(__dirname,file),{workerData});
 worker.on('message',message=>{
  if(message.kind==='fatal'){fail(Error(message.error));return;}
  if(message.kind==='embedding-stats'){if(owner&&!termination)owner.postMessage(message);return;}
  const request=requests.get(message.requestId);if(request?.target===worker)settle(message.requestId,message);
 });
 worker.on('error',error=>fail(Error('JOINT_'+label+'_ERROR:'+error.message)));
 worker.on('exit',code=>{if(!termination)fail(Error('JOINT_'+label+'_EXIT:'+code));});
 return worker;
}
function dispatch(message,target,resolve,reject){
 const timeoutMs=message.timeoutMs??workerData.asyncTimeoutMs??180000;
 const request={...message,target,resolve,reject};requests.set(message.requestId,request);
 request.timer=setTimeout(()=>fail(Error('JOINT_TIMEOUT_UNKNOWN_OUTCOME:'+message.method)),timeoutMs);
 try{target.postMessage({requestId:message.requestId,method:message.method,args:message.args});}
 catch(error){settle(message.requestId,{error:String(error.message)});}
}
async function stop(message){
 stopping=true;const request={...message};requests.set(message.requestId,request);
 request.timer=setTimeout(()=>fail(Error('JOINT_TIMEOUT_UNKNOWN_OUTCOME:stop')),workerData.stopTimeoutMs??180000);
 const results=await Promise.allSettled([owner,embedding].filter(Boolean).map(target=>new Promise((resolve,reject)=>dispatch({requestId:--internalId,method:'stop',args:[]},target,resolve,reject))));
 if(terminalError)return;
 const failure=results.find(result=>result.status==='rejected');if(failure){fail(failure.reason);return;}
 try{await terminate();Atomics.store(control,0,2);settle(message.requestId,{value:true});}catch(error){fail(error);}
}
owner=create('owner.cjs','OWNER');
parentPort.on('message',message=>{
 if(message.method==='receiveResponse'){
  const request=requests.get(message.requestId);
  if(!request?.responseBytes||!(message.shared instanceof SharedArrayBuffer)||message.shared.byteLength<32+request.responseBytes.length){fail(Error('JOINT_RESPONSE_UNKNOWN_OUTCOME:INVALID_BUFFER'));return;}
  request.shared=message.shared;settleShared(message.requestId,request,request.responseBytes);return;
 }
 if(message.method==='abort'){fail(Error(message.error??'JOINT_ABORTED_UNKNOWN_OUTCOME'));return;}
 if(terminalError||Atomics.load(control,0)===1){requests.set(message.requestId,message);settle(message.requestId,{error:terminalError??'JOINT_ABORTED_UNKNOWN_OUTCOME',terminal:true});return;}
 if(stopping){requests.set(message.requestId,message);settle(message.requestId,{error:'JOINT_OWNER_STOPPED'});return;}
 if(message.method==='stop'){void stop(message);return;}
 const target=message.method==='embed'?(embedding??=create('embedding-worker.cjs','EMBEDDING')):owner;
 dispatch(message,target);
});
