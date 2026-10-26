import type { ConversationDatabase } from './conversation-database';
import {compactOperationPayloads,operationDigest} from './life-operation-digest';
const kinds=['posts','comments','reactions'];
const key=(kind:string,row:any)=>kind==='reactions'?JSON.stringify([row.postId,row.actor,row.type]):row.id;
export function momentsStore(database:ConversationDatabase){
 const db=database.db;
 db.exec(`CREATE TABLE IF NOT EXISTS life_moment_rows(kind TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS life_moment_operations(id TEXT PRIMARY KEY,input_json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS life_moment_media_cleanup(post_id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS life_service_migrations(id TEXT PRIMARY KEY);`);
 compactOperationPayloads(database,'life_moment_operations');
 if(!db.prepare("SELECT 1 FROM life_service_migrations WHERE id='moment-rows-v1'").get())database.transaction(()=>{
  const old=db.prepare("SELECT value_json FROM life_service_state WHERE namespace='moments' AND key='state'").get();if(!old)throw Error('MOMENTS_STATE_MISSING');
  const state=JSON.parse(old.value_json as string);
  for(const kind of kinds){if(!Array.isArray(state[kind]))throw Error('MOMENTS_IMPORT_INVALID');state[kind].forEach((row:any,seq:number)=>{
   const id=key(kind,row);if(typeof id!=='string'||!id)throw Error('MOMENTS_ROW_INVALID');
   db.prepare('INSERT INTO life_moment_rows VALUES(?,?,?,?)').run(kind,id,seq,JSON.stringify(row));
  });}
  db.prepare("UPDATE life_service_state SET value_json=? WHERE namespace='moments' AND key='state'").run(JSON.stringify({...state,posts:[],comments:[],reactions:[]}));
  db.prepare("INSERT INTO life_service_migrations VALUES('moment-rows-v1')").run();
 });
 return {
  read(){const state=JSON.parse(db.prepare("SELECT value_json FROM life_service_state WHERE namespace='moments' AND key='state'").get()!.value_json as string);for(const kind of kinds)state[kind]=db.prepare('SELECT value_json FROM life_moment_rows WHERE kind=? ORDER BY seq').all(kind).map(r=>JSON.parse(r.value_json as string));return state;},
  apply(operation:any){return database.transaction(()=>{
   const input=operationDigest(JSON.stringify(operation)),old=db.prepare('SELECT input_json FROM life_moment_operations WHERE id=?').get(operation.id);
   if(old){if(old.input_json!==input)throw Error('MOMENTS_OPERATION_CONFLICT');return;}
   for(const change of operation.changes){
    if(!kinds.includes(change.kind))throw Error('MOMENTS_KIND_INVALID');
    const row=db.prepare('SELECT value_json FROM life_moment_rows WHERE kind=? AND id=?').get(change.kind,change.key);
    if((row?.value_json??null)!==(change.before??null))throw Error('MOMENTS_REVISION_CONFLICT');
    if(change.value===null){db.prepare('DELETE FROM life_moment_rows WHERE kind=? AND id=?').run(change.kind,change.key);if(change.kind==='posts')db.prepare('INSERT OR IGNORE INTO life_moment_media_cleanup VALUES(?)').run(change.key);}
    else {db.prepare('INSERT INTO life_moment_rows VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET seq=excluded.seq,value_json=excluded.value_json').run(change.kind,change.key,change.seq,change.value);if(change.kind==='posts')db.prepare('DELETE FROM life_moment_media_cleanup WHERE post_id=?').run(change.key);}
   }
   db.prepare('INSERT INTO life_moment_operations VALUES(?,?)').run(operation.id,input);
  });},
  reserve(id:string){db.prepare('INSERT OR IGNORE INTO life_moment_media_cleanup VALUES(?)').run(id);},
  pending(){return db.prepare("SELECT post_id FROM life_moment_media_cleanup WHERE post_id NOT IN (SELECT id FROM life_moment_rows WHERE kind='posts')").all().map(r=>r.post_id);},
  cleaned(id:string){db.prepare('DELETE FROM life_moment_media_cleanup WHERE post_id=?').run(id);},
 };
}
