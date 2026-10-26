// Offline, lossless profile switch. The old SQLite generation is never overwritten.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {plain,formalControl}=require('./data-boundary.cjs');
const {selection,options,inventory,write,digest}=require('./formal-storage.cjs');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function rollbackSelection(profile,pending=false){
 const control=path.join(plain(profile),'.sqlite-storage'),pointer=path.join(control,'rollback.json'),intent=path.join(control,'rollback-intent.json');
 if(!fs.existsSync(pointer)&&!fs.existsSync(intent))return;
 formalControl(control);
 if(!fs.existsSync(pointer)&&!pending)throw Error('SQLITE_ROLLBACK_INCOMPLETE');
 const file=fs.existsSync(pointer)?pointer:intent;plain(file);const value=read(file);
 if(fs.existsSync(intent)){plain(intent);assert.deepEqual(value,read(intent),'SQLITE_ROLLBACK_POINTER_MISMATCH');}
 if(value.version!==1||! /^[a-f0-9-]{36}$/.test(value.id))throw Error('SQLITE_ROLLBACK_POINTER_INVALID');
 const folder=path.join(control,'rollbacks',value.id),target=path.join(folder,'profile'),receipt=path.join(folder,'receipt.json');plain(target);plain(receipt);
 if(digest(receipt)!==value.receiptHash||read(receipt).complete!==true)throw Error('SQLITE_ROLLBACK_RECEIPT_INVALID');
 return {control,folder,target,value,receipt:read(receipt)};
}
function resolveRollbackData(profile){
 let current=plain(profile);const seen=new Set();
 while(true){if(seen.has(current))throw Error('SQLITE_ROLLBACK_CYCLE');seen.add(current);const next=rollbackSelection(current);if(!next)return current;current=next.target;}
}
function verifyCandidate(saved){
 for(const [name,key]of [['files.json','filesHash'],['source-files.json','sourceFilesHash'],['transcript-audit.json','auditHash']])assert.equal(digest(path.join(saved.folder,name)),saved.receipt[key],'SQLITE_ROLLBACK_MANIFEST_CHANGED');
 assert.deepEqual(inventory(saved.target),read(path.join(saved.folder,'files.json')),'SQLITE_ROLLBACK_EXPORT_CHANGED');
}
async function rollback(profile,runtimeDir,{point=()=>{}}={}){
 profile=plain(profile);
 const control=path.join(profile,'.sqlite-storage'),intent=path.join(control,'rollback-intent.json'),pointer=path.join(control,'rollback.json');
 if(fs.existsSync(intent)&&!fs.existsSync(pointer)){
  const saved=rollbackSelection(profile,true),source=selection(profile);verifyCandidate(saved);
  assert.equal(digest(path.join(source.data,'cyrene.sqlite')),saved.receipt.databaseHash,'SQLITE_ROLLBACK_DATABASE_CHANGED');
  assert.deepEqual(inventory(profile),read(path.join(saved.folder,'source-files.json')),'SQLITE_ROLLBACK_SOURCE_CHANGED');
  write(pointer,saved.value);return {resumed:true,profile:saved.target};
 }
 const selected=resolveRollbackData(profile);
 if(selected!==profile){if(selection(selected))return rollback(selected,runtimeDir,{point});return {unchanged:true,profile:selected};}
 const source=selection(profile);if(!source)throw Error('SQLITE_ROLLBACK_NOT_ENABLED');
 const id=crypto.randomUUID(),folder=path.join(control,'rollbacks',id),target=path.join(folder,'profile');
 fs.mkdirSync(target,{recursive:true});const before=inventory(profile);
 for(const name of fs.readdirSync(profile)){if(['.sqlite-storage','SingletonLock','SingletonCookie','SingletonSocket','lockfile'].includes(name))continue;
  fs.cpSync(path.join(profile,name),path.join(target,name),{recursive:true,filter:file=>{plain(file);return true;}});
 }
 assert.deepEqual(inventory(target),before,'SQLITE_ROLLBACK_COPY_CHANGED');point('snapshot');
 const bridge=require('./bridge.cjs')(options(profile,runtimeDir));let exported;
 try{bridge.start();exported=await bridge.exportJson();}finally{await bridge.stop();}
 if(exported.shellJobs?.length)throw Error('SQLITE_ROLLBACK_SHELL_JOBS_UNSUPPORTED');
 const safe=value=>{if(typeof value!=='string'||! /^[a-zA-Z0-9_-]+$/.test(value))throw Error('SQLITE_ROLLBACK_UNSAFE_RECORD_ID');return value;};
 point('export');
 // Replace stale service projections with the SQLite authority before selecting JSON.
 const serviceFiles={moments:'moments.json',usage:'token-usage.json','channel-delivery':'channel-delivery.json'};
 for(const [name,file]of Object.entries(serviceFiles))if(exported.services?.[name])write(path.join(target,file),name==='channel-delivery'?exported.services[name]:exported.services[name].state);
 if(exported.services?.tasks){
  const directory=path.join(target,'cyrene-tasks/sessions');fs.mkdirSync(directory,{recursive:true});
  for(const file of fs.readdirSync(directory))if(file.endsWith('.json'))fs.unlinkSync(path.join(directory,file));
  const index=[];for(const [id,session]of Object.entries(exported.services.tasks)){safe(id);write(path.join(directory,id+'.json'),session);index.push({id,parentConversationId:session.parentConversationId,status:session.status,updatedAt:session.updatedAt});}
  write(path.join(target,'cyrene-tasks/index.json'),index);
 }
 if(exported.services?.['channel-history'])for(const [key,rows]of Object.entries(exported.services['channel-history'])){
  if(!/^[a-zA-Z0-9_-]+$/.test(key))throw Error('CHANNEL_HISTORY_EXPORT_KEY');
  const file=path.join(target,'channels/history',key+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 }
 if(exported.toolOperations?.length)write(path.join(target,'execution-ledger.json'),exported.toolOperations);
 write(path.join(target,'plugin-agent-runs.json'),exported.pluginAgentRuns??[]);
 // JSON consumes the exact current session view. Keep revisions, tombstones and
 // compaction entries separately, as well as retaining the untouched SQL authority.
 write(path.join(folder,'transcript-audit.json'),exported.transcripts);
 const managed=['cyrene-chats/sessions','cyrene-runs/sessions','plugin-data/companion-chat','plugin-data/companion-memory'];
 // Remove stale state files, but preserve attachments and tool-output files in these namespaces.
 for(const name of managed){const directory=path.join(target,name);plain(directory);fs.mkdirSync(directory,{recursive:true});
  for(const entry of fs.readdirSync(directory,{withFileTypes:true}))if(entry.isFile()&&(entry.name.endsWith('.json')||entry.name.endsWith('.events.jsonl')))fs.unlinkSync(path.join(directory,entry.name));}
 const put=(name,value)=>{const file=path.join(target,name);fs.mkdirSync(path.dirname(file),{recursive:true});write(file,value);};

 put('cyrene-chats/index.json',exported.index);
 put('cyrene-chats/index.last-good.json',exported.index);
 const interruptedIndex=path.join(target,'cyrene-chats/index.json.tmp');if(fs.existsSync(interruptedIndex))fs.unlinkSync(interruptedIndex);
 for(const session of exported.sessions)put('cyrene-chats/sessions/'+safe(session.id)+'.json',session);
 fs.mkdirSync(path.join(target,'cyrene-chats/sessions'),{recursive:true});
 for(const [plugin,values]of Object.entries(exported.values))for(const [key,value]of Object.entries(values))put('plugin-data/'+safe(plugin)+'/'+safe(key)+'.json',value);
 const runIndex=[];fs.mkdirSync(path.join(target,'cyrene-runs/sessions'),{recursive:true});
 for(const run of exported.runs){const id=safe(run.runId);put('cyrene-runs/sessions/'+id+'.json',run);runIndex.push({conversationId:run.conversationId,runId:id,status:run.status,updatedAt:run.updatedAt});
  fs.writeFileSync(path.join(target,'cyrene-runs/sessions/'+id+'.events.jsonl'),exported.events[id].map(e=>JSON.stringify(e)).join('\n')+'\n');}
 put('cyrene-runs/index.json',runIndex);
 // Verify exact JSON round trips, including indexes, attachment metadata and pending memory turns.
 for(const session of exported.sessions)assert.deepEqual(read(path.join(target,'cyrene-chats/sessions',session.id+'.json')),session);
 for(const [plugin,values]of Object.entries(exported.values))for(const [key,value]of Object.entries(values))assert.deepEqual(read(path.join(target,'plugin-data',plugin,key+'.json')),value);
 for(const run of exported.runs)assert.deepEqual(read(path.join(target,'cyrene-runs/sessions',run.runId+'.json')),run);
 assert.deepEqual(inventory(profile),before,'SQLITE_ROLLBACK_SOURCE_CHANGED');
 write(path.join(folder,'source-files.json'),before);write(path.join(folder,'files.json'),inventory(target));
 const receipt={version:1,complete:true,sourceGeneration:source.active.generation,databaseHash:digest(path.join(source.data,'cyrene.sqlite')),auditHash:digest(path.join(folder,'transcript-audit.json')),sessions:exported.sessions.length,messages:exported.sessions.reduce((n,s)=>n+s.messages.length,0),runs:exported.runs.length,pendingMemory:exported.pendingMemory,removedOwnershipMarker:'isolated-sqlite-pending-owner'};
 receipt.filesHash=digest(path.join(folder,'files.json'));receipt.sourceFilesHash=digest(path.join(folder,'source-files.json'));
 write(path.join(folder,'receipt.json'),receipt);point('verified');
 const value={version:1,id,receiptHash:digest(path.join(folder,'receipt.json'))};write(intent,value);point('intent');write(pointer,value);point('activated');
 return {unchanged:false,profile:target,...receipt};
}
module.exports={resolveRollbackData,rollback};
