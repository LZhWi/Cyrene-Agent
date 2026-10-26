// Keep the life branch's complete Harness checkpoint schema. Do not feed these
// records to the newer upstream schema-2 runner or discard tool-output refs.
import type { ConversationDatabase } from './conversation-database';
import fs from 'node:fs';
import path from 'node:path';
export function initializeLifeHarness(db: ConversationDatabase) {
  db.db.exec('CREATE TABLE IF NOT EXISTS life_harness_source_import(id INTEGER PRIMARY KEY CHECK(id=1),receipt_json TEXT NOT NULL)');
  db.db.exec('CREATE TABLE IF NOT EXISTS life_harness_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,event_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS life_harness_sessions(run_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),record_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS life_harness_imports(run_id TEXT PRIMARY KEY)');
  const directory=path.join(db.userDataRoot,'cyrene-runs','sessions');
  for(const row of db.db.prepare("SELECT run_id FROM runs WHERE json_extract(record_json,'$.schemaVersion')=1").all()) {
    const runId=row.run_id as string;
    if(path.basename(runId)!==runId||db.db.prepare('SELECT 1 FROM life_harness_imports WHERE run_id=?').get(runId))continue;
    const file=path.join(directory,runId+'.events.jsonl');
    const records=fs.existsSync(file)?fs.readFileSync(file,'utf8').split(/\r?\n/).filter(line=>line.trim()).map(line=>{
      const value=JSON.parse(line);if(!value||typeof value.type!=='string'||!Number.isFinite(value.at))throw Error('HARNESS_LEGACY_EVENT_INVALID');return value;
    }):[];
    db.transaction(()=>{for(const value of records)db.db.prepare('INSERT INTO life_harness_events(run_id,event_json) VALUES(?,?)').run(runId,JSON.stringify(value));db.db.prepare('INSERT INTO life_harness_imports VALUES(?)').run(runId);});
  }
}
export function harnessCommand(db: ConversationDatabase, method: string, args: any[]): any {
  if(method==='harness.importReceipt'){
    const row=db.db.prepare('SELECT receipt_json FROM life_harness_source_import WHERE id=1').get();return row?JSON.parse(row.receipt_json as string):null;
  }
  if(method==='harness.importLegacy')return db.transaction(()=>{
    const previous=harnessCommand(db,'harness.importReceipt',[]);if(previous)return previous;
    const {records,events,sources}=args[0],imported:string[]=[],retained:string[]=[];
    for(const [id,raw]of Object.entries(records) as [string,any][]){
      if(raw.schemaVersion!==1||raw.runId!==id||!raw.conversationId||!Array.isArray(raw.messages)||!Array.isArray(raw.toolCalls)||!Number.isFinite(raw.createdAt)||!Number.isFinite(raw.updatedAt)||!['running','interrupted','completed','failed','cancelled'].includes(raw.status))throw Error('HARNESS_LEGACY_INVALID:'+id);
      if(harnessCommand(db,'harness.get',[id])||db.db.prepare('SELECT deleted FROM conversations WHERE id=?').get(raw.conversationId)?.deleted){retained.push(id);continue;}
      const record=raw.status==='running'?{...raw,status:'interrupted',updatedAt:Date.now()}:raw;
      harnessCommand(db,'harness.commit',[record,{type:'legacy_imported',at:Date.now()}]);
      for(const event of events[id]??[]){if(typeof event.type!=='string'||!Number.isFinite(event.at))throw Error('HARNESS_LEGACY_EVENT_INVALID');db.db.prepare('INSERT INTO life_harness_events(run_id,event_json) VALUES(?,?)').run(id,JSON.stringify(event));}
      imported.push(id);
    }
    const receipt={version:1,imported,retained,sources};db.db.prepare('INSERT INTO life_harness_source_import VALUES(1,?)').run(JSON.stringify(receipt));return receipt;
  });
  if(method==='harness.all')return db.db.prepare('SELECT record_json FROM life_harness_sessions UNION ALL SELECT record_json FROM runs WHERE run_id NOT IN(SELECT run_id FROM life_harness_sessions)').all().map(r=>JSON.parse(r.record_json as string)).filter(r=>r.schemaVersion===1&&Array.isArray(r.messages));
  if(method==='harness.get'){
    const row=db.db.prepare('SELECT record_json FROM life_harness_sessions WHERE run_id=?').get(args[0])??db.db.prepare('SELECT record_json FROM runs WHERE run_id=?').get(args[0]);return row?JSON.parse(row.record_json as string):null;
  }
  if(method==='harness.commit')return db.transaction(()=>{
    const [session,event]=args;
    if(session.schemaVersion!==1||!session.runId||!session.conversationId||!Array.isArray(session.messages)||!Array.isArray(session.toolCalls))throw Error('HARNESS_CHECKPOINT_INVALID');
    const conversation=db.record(session.conversationId);
    if(conversation&&!['chat','work','code','learn'].includes(conversation.mode??''))throw Error('HARNESS_CONVERSATION_REQUIRED');
    // Null-record scopes persist headless/default runs without exposing a desktop chat.
    db.ensure(session.conversationId);
    const previous=db.db.prepare('SELECT conversation_id,record_json FROM runs WHERE run_id=?').get(session.runId);
    if(previous&&previous.conversation_id!==session.conversationId)throw Error('HARNESS_RUN_ID_CONFLICT');
    const checkpoint=db.db.prepare('SELECT conversation_id FROM life_harness_sessions WHERE run_id=?').get(session.runId);
    if(checkpoint&&checkpoint.conversation_id!==session.conversationId)throw Error('HARNESS_RUN_ID_CONFLICT');
    if((!previous||JSON.parse(previous.record_json as string).schemaVersion===1)&&session.status==='running'){
      const active=db.db.prepare("SELECT run_id FROM runs WHERE conversation_id=? AND run_id<>? AND status IN ('prepared','running')").get(session.conversationId,session.runId);
      if(active)throw Error('HARNESS_SCOPE_BUSY: 此会话已有正在运行的任务，请等待其结束或取消后重试。');
    }
    // Chat's admitted run settles only after renderer persistence. A Tool-stage
    // checkpoint completing must not prematurely mark that source as delivered.
    db.db.prepare('INSERT INTO life_harness_sessions VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET record_json=excluded.record_json').run(session.runId,session.conversationId,JSON.stringify(session));
    if(!previous||JSON.parse(previous.record_json as string).schemaVersion===1)db.db.prepare('INSERT INTO runs(run_id,conversation_id,status,record_json) VALUES(?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json').run(session.runId,session.conversationId,session.status,JSON.stringify(session));
    db.db.prepare('INSERT INTO life_harness_events(run_id,event_json) VALUES(?,?)').run(session.runId,JSON.stringify(event));
    for(const message of session.messages) {
      if(message.role!=='tool'||typeof message.toolCallId!=='string'||typeof message.content!=='string')continue;
      db.db.prepare("UPDATE tool_operations SET status='succeeded' WHERE scope_id=? AND operation_id=? AND status='ready'")
        .run(`${session.conversationId}:${session.runId}`,`${session.runId}:${message.toolCallId}`);
    }
    return true;
  });
  if(method==='harness.event')return db.transaction(()=>{const [runId,event]=args;if(!db.db.prepare('SELECT 1 FROM runs WHERE run_id=?').get(runId))throw Error('HARNESS_RUN_NOT_FOUND');db.db.prepare('INSERT INTO life_harness_events(run_id,event_json) VALUES(?,?)').run(runId,JSON.stringify(event));return true;});
  if(method==='harness.delete')return db.transaction(()=>{db.db.prepare('DELETE FROM life_harness_events WHERE run_id IN(SELECT run_id FROM life_harness_sessions WHERE conversation_id=? UNION SELECT run_id FROM runs WHERE conversation_id=?)').run(args[0],args[0]);db.db.prepare('DELETE FROM life_harness_sessions WHERE conversation_id=?').run(args[0]);db.db.prepare("DELETE FROM runs WHERE conversation_id=? AND json_extract(record_json,'$.schemaVersion')=1").run(args[0]);return true;});
  if(method==='harness.audit')return db.db.prepare('SELECT event_json FROM life_harness_events WHERE run_id=? ORDER BY seq').all(args[0]).map(r=>JSON.parse(r.event_json as string));
  throw Error('HARNESS_COMMAND_UNKNOWN');
}
