import {createHash} from 'node:crypto';
import type {ConversationDatabase} from './conversation-database';
export const operationDigest=(input:string)=>'sha256:'+createHash('sha256').update(input).digest('hex');

/** Retain the idempotency key permanently; only discard the already-applied payload. */
export function compactOperationPayloads(database:ConversationDatabase,table:'life_usage_operations'|'life_moment_operations'){
  const marker=table+'-digests-v1',db=database.db;
  if(db.prepare('SELECT 1 FROM life_service_migrations WHERE id=?').get(marker))return;
  database.transaction(()=>{
    for(const row of db.prepare(`SELECT id,input_json FROM ${table}`).iterate()){
      const input=row.input_json as string;
      if(/^sha256:[a-f0-9]{64}$/.test(input))continue;
      JSON.parse(input); // Invalid receipts must not silently become valid hashes.
      db.prepare(`UPDATE ${table} SET input_json=? WHERE id=?`).run(operationDigest(input),row.id);
    }
    db.prepare('INSERT INTO life_service_migrations VALUES(?)').run(marker);
  });
}
