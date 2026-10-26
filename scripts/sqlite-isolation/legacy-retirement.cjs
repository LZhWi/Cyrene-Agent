// Offline cleanup: caller holds the profile lock. Never delete unproven or changed sources.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {selection,digest,write}=require('./formal-storage.cjs'),{plain}=require('./data-boundary.cjs'),snapshots=require('./profile-snapshot.cjs');
function plan(profile){
 profile=plain(profile);const selected=selection(profile);if(!selected)throw Error('SQLITE_NOT_INITIALIZED');
 const receipt=JSON.parse(fs.readFileSync(path.join(selected.generation,'receipt.json'))),manifestPath=path.join(selected.generation,'snapshot-manifest.json');
 assert.equal(digest(manifestPath),receipt.sourceManifestHash,'LEGACY_SOURCE_MANIFEST_CHANGED');
 const manifest=JSON.parse(fs.readFileSync(manifestPath));
 const indexed=new Set();
 if(manifest['cyrene-chats/index.json']){
  const indexFile=plain(path.join(selected.generation,'snapshot/cyrene-chats/index.json'));
  assert.equal(digest(indexFile),manifest['cyrene-chats/index.json'],'LEGACY_CHAT_INDEX_CHANGED');
  for(const row of JSON.parse(fs.readFileSync(indexFile)))indexed.add(row.id);
 }
 const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(path.toNamespacedPath(path.join(selected.data,'cyrene.sqlite')),{readOnly:true});
 const candidates=new Map();
 try{
  assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check),['ok']);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  const imported=db.prepare('SELECT receipt_json FROM life_startup_import WHERE id=1').get();if(!imported)throw Error('LEGACY_SERVICE_IMPORT_INCOMPLETE');
  for(const [name,hash]of Object.entries(manifest)){
   const session=/^cyrene-chats\/sessions\/(.+?)(?:\.last-good)?\.json$/.exec(name);
   if(name==='cyrene-chats/index.json'||session&&indexed.has(session[1])||/^plugin-data\/(?:companion-chat|companion-memory)\/[^/]+\.json$/.test(name)&&!name.endsWith('.last-good.json'))candidates.set(name,hash);
  }
  for(const [name,hash]of Object.entries(JSON.parse(imported.receipt_json).sources??{}))if(hash&&(/^(?:token-usage|moments|channel-delivery|execution-ledger)\.json$/.test(name)||/^(?:cyrene-tasks[\\/]sessions|channels[\\/]history)[\\/][^\\/]+\.(?:json|jsonl)$/.test(name)))candidates.set(name,hash);
  const harness=db.prepare('SELECT receipt_json FROM life_harness_source_import WHERE id=1').get();
  if(!harness)throw Error('LEGACY_HARNESS_IMPORT_INCOMPLETE');
  const runs=JSON.parse(harness.receipt_json);
  for(const [name,hash]of Object.entries(runs.sources??{})){
   const match=/^cyrene-runs[\\/]sessions[\\/]([^\\/]+?)\.(?:json|events\.jsonl)$/.exec(name);
   if(match&&runs.imported.includes(match[1]))candidates.set(name,hash);
  }
 }finally{db.close();}
 const files=[];for(const [name,hash]of candidates){const file=plain(path.join(profile,name));if(!fs.existsSync(file))continue;if(digest(file)!==hash)throw Error('LEGACY_SOURCE_CHANGED:'+name);files.push({name,sha256:hash});}
 return files;
}
function retire(profile,backup){
 profile=plain(profile);const files=plan(profile);
 // Refuse deletion until a complete, independently verified recovery snapshot exists.
 snapshots.capture(profile,backup);snapshots.verify(backup);
 for(const item of files){const file=plain(path.join(profile,item.name));assert.equal(digest(file),item.sha256,'LEGACY_SOURCE_CHANGED');fs.unlinkSync(file);}
 const receipt={version:1,at:new Date().toISOString(),backup,removed:files};write(path.join(profile,'.sqlite-storage/legacy-retirement.json'),receipt);return receipt;
}
module.exports={plan,retire};
