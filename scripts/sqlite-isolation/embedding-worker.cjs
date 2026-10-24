const {parentPort,workerData}=require('node:worker_threads'),path=require('node:path'),fs=require('node:fs');
const root=path.resolve(workerData.data),base=fs.realpathSync(workerData.runtime);
if(!root.startsWith(base+path.sep))throw Error('JOINT_ISOLATION_REQUIRED');
let provider,tail=Promise.resolve(),closed=false;
async function execute(method,args){
 if(method==='stop'){await provider?.dispose();closed=true;return true;}
 if(closed)throw Error('JOINT_EMBEDDING_STOPPED');
 if(method!=='embed')throw Error('JOINT_UNKNOWN_EMBEDDING_COMMAND:'+method);
 if(!provider){const {localEmbedding}=await import(require('node:url').pathToFileURL(path.join(workerData.runtime,'local-real-embedding.mjs')));provider=await localEmbedding(root);}
 const vectors=[];for(const text of args[0])vectors.push(await provider.embed(text));
 parentPort.postMessage({kind:'embedding-stats',identity:provider.identity,calls:provider.calls});return vectors;
}
parentPort.on('message',message=>{tail=tail.then(async()=>{
 let result;try{result={value:await execute(message.method,message.args)};}catch(error){result={error:String(error.stack)};}
 parentPort.postMessage({requestId:message.requestId,...result});
}).catch(error=>{setImmediate(()=>{throw error;});});});
