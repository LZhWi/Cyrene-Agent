// Called before application services start, while Electron holds its profile lock.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {plain,formalControl}=require('./data-boundary.cjs');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const digest=file=>{try{return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}catch(error){error.message+=' [snapshot file: '+file+']';throw error;}};
const SKIP=new Set(['.sqlite-storage','SingletonLock','SingletonCookie','SingletonSocket','lockfile']);
const runtimeLock=(root,file)=>{
 const relative=path.relative(root,file).replaceAll('\\','/');
 return /^(?:session-data\/)?(?:Local Storage|Session Storage)\/(?:.*\/)?LOCK$/.test(relative)
  || /^(?:session-data\/)?(?:Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|Shared Dictionary)(?:\/|$)/.test(relative);
};
function inventory(root){
 const files={};function walk(dir){plain(dir);for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  if(dir===root&&SKIP.has(e.name))continue;const file=path.join(dir,e.name);if(runtimeLock(root,file))continue;plain(file);
  if(e.isDirectory())walk(file);else if(e.isFile())files[path.relative(root,file).replaceAll('\\','/')]=digest(file);else throw Error('SQLITE_SNAPSHOT_SPECIAL_FILE');
 }}walk(root);return files;
}
function write(file,value){const tmp=file+'.'+crypto.randomUUID()+'.tmp',fd=fs.openSync(tmp,'wx');try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
function selection(profile, resumePending=false){
 profile=plain(profile);const control=path.join(profile,'.sqlite-storage'),pointer=path.join(control,'active.json');
 const intent=path.join(control,'activation.json');
 if(!fs.existsSync(pointer)&&!fs.existsSync(intent)){
  if(fs.existsSync(path.join(control,'sqlite-required.json')))throw Error('SQLITE_SELECTION_MISSING: SQLite 已启用但激活指针丢失，请恢复已验证的指针或快照；已阻止读取旧 JSON。');
  const generations=path.join(control,'generations');
  if(fs.existsSync(generations))for(const name of fs.readdirSync(generations)){
   const receipt=path.join(generations,name,'receipt.json');
   if(fs.existsSync(receipt)){plain(receipt);const saved=read(receipt);if(saved.complete===true&&saved.activationProtocol!==2)throw Error('SQLITE_SELECTION_MISSING: 发现旧版已完成的 SQLite 数据，无法确认是否曾激活；已阻止读取旧 JSON。');}
  }
  return undefined;
 }
 formalControl(control);
 if(!fs.existsSync(pointer)&&!resumePending)throw Error('SQLITE_ACTIVATION_INCOMPLETE');
 const selectedFile=fs.existsSync(pointer)?pointer:intent;plain(selectedFile);const active=read(selectedFile);
 if(fs.existsSync(intent)){plain(intent);assert.deepEqual(active,read(intent),'SQLITE_ACTIVATION_MISMATCH');}
 if(active.version!==1||active.backend!=='sqlite'||! /^[a-f0-9-]{36}$/.test(active.generation))throw Error('SQLITE_SELECTION_INVALID');
 const generation=path.join(control,'generations',active.generation);plain(generation);
 const receipt=path.join(generation,'receipt.json');plain(receipt);
 const result=read(receipt);
 if(digest(receipt)!==active.receiptHash||result.version!==1||result.generation!==active.generation||result.complete!==true)throw Error('SQLITE_MIGRATION_RECEIPT_INVALID');
 const data=path.join(generation,'data');plain(data);
 if(!fs.existsSync(path.join(data,'cyrene.sqlite')))throw Error('SQLITE_ACTIVE_DATABASE_MISSING');
 return {control,generation,data,active};
}
function options(profile,runtimeDir){
 const selected=selection(profile);if(!selected)return undefined;
 return {runtime:path.join(runtimeDir,'runtime'),data:selected.data,storageRoot:selected.control,snapshot:path.join(selected.generation,'snapshot'),report:path.join(selected.generation,'owner-report.json')};
}
async function migrate(profile,runtimeDir,{point=()=>{}}={}){
 profile=plain(profile);
 const pending=path.join(profile,'.sqlite-storage/activation.json'),pointer=path.join(profile,'.sqlite-storage/active.json');
 if(!fs.existsSync(pointer)&&fs.existsSync(pending)){
  const saved=selection(profile,true),manifest=path.join(saved.generation,'snapshot-manifest.json');
  assert.equal(digest(manifest),read(path.join(saved.generation,'receipt.json')).sourceManifestHash,'SQLITE_SNAPSHOT_MANIFEST_CHANGED');
  assert.deepEqual(inventory(profile),read(manifest),'SQLITE_SOURCE_CHANGED');
  verifyDatabase(saved.data);write(pointer,saved.active);return {unchanged:false,resumed:true,generation:saved.active.generation};
 }
 const existing=selection(profile);if(existing){verifyDatabase(existing.data);return {unchanged:true,generation:existing.active.generation};}
 const control=path.join(profile,'.sqlite-storage');fs.mkdirSync(control,{recursive:true});plain(control);
 const identity=path.join(control,'identity.json');if(!fs.existsSync(identity))write(identity,{version:1,profile});formalControl(control);
 const id=crypto.randomUUID(),generation=path.join(control,'generations',id),snapshot=path.join(generation,'snapshot'),data=path.join(generation,'data');
 fs.mkdirSync(snapshot,{recursive:true});const before=inventory(profile);
 for(const name of fs.readdirSync(profile)){if(SKIP.has(name))continue;fs.cpSync(path.join(profile,name),path.join(snapshot,name),{recursive:true,filter:file=>{plain(file);return !runtimeLock(profile,file);}});}
 assert.deepEqual(inventory(snapshot),before,'SQLITE_SNAPSHOT_MISMATCH');assert.deepEqual(inventory(profile),before,'SQLITE_SOURCE_CHANGED');
 write(path.join(generation,'snapshot-manifest.json'),before);point('snapshot');
 // Empty profiles still need valid import inputs; these defaults live only in the snapshot.
 const defaults={'cyrene-chats/index.json':[],'plugin-data/companion-memory/memory-state.json':{turns:[],processed:[],l2:[]},'plugin-data/companion-chat/chat-state.json':{sessions:[]}};
 for(const [name,value]of Object.entries(defaults)){const file=path.join(snapshot,name);if(!fs.existsSync(file)){fs.mkdirSync(path.dirname(file),{recursive:true});write(file,value);}}
 fs.mkdirSync(path.join(snapshot,'cyrene-chats/sessions'),{recursive:true});
 const bridge=require('./bridge.cjs')({runtime:path.join(runtimeDir,'runtime'),storageRoot:control,data,snapshot,report:path.join(generation,'owner-report.json')});
 let counts;
 try{
  bridge.start();point('import');
  const index=read(path.join(snapshot,'cyrene-chats/index.json')),sessions=bridge.store.listSessions();
  assert.deepEqual(sessions.map(s=>s.id).sort(),index.map(s=>s.id).sort(),'SQLITE_SESSION_SET_MISMATCH');
  let messages=0;for(const row of index){const original=read(path.join(snapshot,'cyrene-chats/sessions',row.id+'.json')),actual=bridge.store.getSession(row.id);
   for(const key of Object.keys(original))assert.deepEqual(actual[key],original[key],'SQLITE_SESSION_FIELDS_MISMATCH:'+row.id+'/'+key);
   messages+=original.messages.length;
  }
  // Source binding intentionally adds hostSourceVersion; every original plugin field must survive.
  for(const plugin of ['companion-chat','companion-memory'])for(const file of fs.readdirSync(path.join(snapshot,'plugin-data',plugin)).filter(f=>f.endsWith('.json')&&!f.endsWith('.last-good.json'))){
   const original=read(path.join(snapshot,'plugin-data',plugin,file)),actual=bridge.pluginStorage(plugin).get(file.slice(0,-5));
   if(file==='memory-state.json')for(const turn of actual.turns??[]){const source=original.turns.find(t=>t.id===turn.id);if(source&&!Object.hasOwn(source,'hostSourceVersion'))delete turn.hostSourceVersion;}
   assert.deepEqual(actual,original,'SQLITE_PLUGIN_FIELDS_MISMATCH:'+plugin+'/'+file);
  }
  counts={sessions:index.length,messages};
 }finally{await bridge.stop();}
 point('closed');
 verifyDatabase(data);
 assert.deepEqual(inventory(profile),before,'SQLITE_SOURCE_CHANGED');
 const receipt=path.join(generation,'receipt.json');write(receipt,{version:1,complete:true,activationProtocol:2,generation:id,counts,sourceManifestHash:digest(path.join(generation,'snapshot-manifest.json')),createdAt:new Date().toISOString()});
 point('verified');const active={version:1,backend:'sqlite',generation:id,receiptHash:digest(receipt)};
 write(path.join(control,'sqlite-required.json'),{version:1,generation:id});
 write(path.join(control,'activation.json'),active);point('activation-intent');write(path.join(control,'active.json'),active);point('activated');
 return {unchanged:false,generation:id,...counts};
}
function verifyDatabase(data){const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.toNamespacedPath(path.join(data,'cyrene.sqlite')),{readOnly:true});
 try{assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check),['ok']);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);}finally{db.close();}}
module.exports={selection,options,migrate,inventory,write,digest};
