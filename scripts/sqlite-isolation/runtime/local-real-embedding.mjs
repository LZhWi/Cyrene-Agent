import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
export const modelRoot='E:/Philia093 demo/Cyrene-Agent/models';
export const hash=v=>crypto.createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
export async function localEmbedding(output){
 const {pipeline,env}=await import('@xenova/transformers');
 env.allowLocalModels=true;env.allowRemoteModels=false;env.useBrowserCache=false;env.useFSCache=false;env.localModelPath=modelRoot;
 const ort=require('onnxruntime-node'),create=ort.InferenceSession.create.bind(ort.InferenceSession);
 ort.InferenceSession.create=(model,options={})=>create(model,{...options,intraOpNumThreads:8,interOpNumThreads:1});
 // A missing asset must fail, never download or send user text to a server.
 globalThis.fetch=()=>{throw Error('NETWORK_DISABLED');};
 const files={};for(const f of ['config.json','tokenizer.json','tokenizer_config.json','onnx/model_quantized.onnx'])files[f]=hash(fs.readFileSync(path.join(modelRoot,'Xenova/bge-m3',f)));
 const pipe=await pipeline('feature-extraction','Xenova/bge-m3',{quantized:true,cache_dir:path.join(output,'model-cache')});
 let tail=Promise.resolve(),calls=0;
 return {files,identity:'local:Xenova/bge-m3:1024:'+hash(files),get calls(){return calls;},embed(text){const job=tail.then(async()=>{calls++;const result=await pipe(text,{pooling:'mean',normalize:true});return Array.from(result.data);});tail=job.catch(()=>{});return job;},async dispose(){await tail;await pipe.dispose();}};
}
