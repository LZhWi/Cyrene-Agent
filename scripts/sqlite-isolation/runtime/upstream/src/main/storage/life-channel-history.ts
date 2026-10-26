import type { ConversationDatabase } from './conversation-database';
import * as chats from '../chats/chats-store-core';
import { lifeChatCommand } from './life-chat-adapter';
import { createHash } from 'node:crypto';

/** One row per history entry. Projection/export retains the legacy JSON shape. */
export function channelHistory(database: ConversationDatabase) {
  const db = database.db;
  db.exec(`CREATE TABLE IF NOT EXISTS life_channel_sessions(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS life_channel_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL, entry_id TEXT NOT NULL, value_json TEXT NOT NULL,
      UNIQUE(session_id,entry_id));
    CREATE TABLE IF NOT EXISTS life_service_migrations(id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS life_channel_deliveries(receipt_id TEXT PRIMARY KEY,value_json TEXT NOT NULL,session_id TEXT,entry_id TEXT);
    CREATE TABLE IF NOT EXISTS life_channel_sources(session_id TEXT NOT NULL,entry_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,input_hash TEXT NOT NULL,PRIMARY KEY(session_id,entry_id));`);
  const exists = (id: string) => Boolean(db.prepare('SELECT 1 FROM life_channel_sessions WHERE id=?').get(id));
  const append = (id: string, entry: any) => {
    if (!entry || !['user', 'assistant'].includes(entry.role) || typeof entry.content !== 'string' || typeof entry.id !== 'string') throw Error('CHANNEL_HISTORY_ENTRY_INVALID');
    const old = db.prepare('SELECT value_json FROM life_channel_entries WHERE session_id=? AND entry_id=?').get(id, entry.id);
    if (old) {
      const saved = JSON.parse(old.value_json as string);
      if (saved.role !== entry.role || saved.content !== entry.content) throw Error('CHANNEL_HISTORY_ID_CONFLICT');
      return;
    }
    database.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO life_channel_sessions VALUES(?)').run(id);
      db.prepare('INSERT INTO life_channel_entries(session_id,entry_id,value_json) VALUES(?,?,?)').run(id, entry.id, JSON.stringify(entry));
    });
  };
  if (!db.prepare("SELECT 1 FROM life_service_migrations WHERE id='channel-rows-v1'").get()
    && db.prepare("SELECT 1 FROM life_service_namespaces WHERE name='channel-history'").get()) {
    database.transaction(() => {
      for (const row of db.prepare("SELECT key,value_json FROM life_service_state WHERE namespace='channel-history'").all()) {
        const id = row.key as string, entries = JSON.parse(row.value_json as string);
        if (!Array.isArray(entries)) throw Error('CHANNEL_HISTORY_IMPORT_INVALID');
        db.prepare('INSERT OR IGNORE INTO life_channel_sessions VALUES(?)').run(id);
        entries.forEach((entry: any, index: number) => append(id, { ...entry, id: entry.id ?? `legacy:${index}` }));
      }
      db.prepare("DELETE FROM life_service_state WHERE namespace='channel-history'").run();
      db.prepare("INSERT INTO life_service_migrations VALUES('channel-rows-v1')").run();
    });
  }
  const recent = (id: string, limit: number) => {
    const sessions=new Map<string,ReturnType<typeof chats.getSession>>();
    const output:any[]=[];
    for(const row of db.prepare('SELECT e.value_json,s.conversation_id,s.message_id FROM life_channel_entries e LEFT JOIN life_channel_sources s ON s.session_id=e.session_id AND s.entry_id=e.entry_id WHERE e.session_id=? ORDER BY e.seq DESC').iterate(id)){
      if(limit>=0&&output.length>=limit)break;
      const value=JSON.parse(row.value_json as string);
      if(row.conversation_id){
        const conversationId=row.conversation_id as string;
        if(!sessions.has(conversationId))sessions.set(conversationId,chats.getSession(conversationId));
        const message=sessions.get(conversationId)?.messages.find(m=>m.id===row.message_id);
        if(!message)continue;
        value.content=message.modelContext?.trim()||message.content;
      }
      output.push(value);
    }
    return output.reverse();
  };
  const all = () => Object.fromEntries(db.prepare('SELECT id FROM life_channel_sessions').all().map(row => [row.id, recent(row.id as string, -1)]));
  if(!db.prepare("SELECT 1 FROM life_service_migrations WHERE id='channel-deliveries-v1'").get()
    &&db.prepare("SELECT 1 FROM life_service_namespaces WHERE name='channel-delivery'").get())database.transaction(()=>{
    for(const row of db.prepare("SELECT key,value_json FROM life_service_state WHERE namespace='channel-delivery'").all()){
      const saved=JSON.parse(row.value_json as string);
      if(!['sending','failed','delivered','committed'].includes(saved.status))throw Error('CHANNEL_RECEIPT_IMPORT_INVALID');
      db.prepare('INSERT INTO life_channel_deliveries(receipt_id,value_json) VALUES(?,?)').run(row.key,row.value_json);
    }
    db.prepare("DELETE FROM life_service_state WHERE namespace='channel-delivery'").run();
    db.prepare("INSERT INTO life_service_migrations VALUES('channel-deliveries-v1')").run();
  });
  const deliveryGet=(key:string)=>{const row=db.prepare('SELECT value_json FROM life_channel_deliveries WHERE receipt_id=?').get(key);return row?JSON.parse(row.value_json as string):undefined;};
  const history={ append, recent, all, exists, bind(id:string,input:any){
    const {conversationId,message,entry}=input;
    if(!entry||!['user','assistant'].includes(entry.role)||typeof entry.id!=='string'||typeof message?.content!=='string'||message.role!==(entry.role==='assistant'?'model':'user'))throw Error('CHANNEL_HISTORY_ENTRY_INVALID');
    const inputHash=createHash('sha256').update(JSON.stringify([message.role,message.content,message.modelContext??null,message.sticker??null,message.channelSource??null])).digest('hex');
    return database.transaction(()=>{
      const source=db.prepare('SELECT conversation_id,message_id,input_hash FROM life_channel_sources WHERE session_id=? AND entry_id=?').get(id,entry.id);
      if(source){if(source.conversation_id!==conversationId||source.message_id!==message.id||source.input_hash!==inputHash)throw Error('CHANNEL_HISTORY_ID_CONFLICT');return;}
      const session=chats.getSession(conversationId);if(!session)throw Error('CHANNEL_CONVERSATION_MISSING');
      const existing=session.messages.find(m=>m.id===message.id);
      if(existing){if(existing.content!==message.content||existing.role!==message.role)throw Error('CHANNEL_MIRROR_CONFLICT');}
      else lifeChatCommand(database,chats,session.mode==='chat'?'life.mutate':'life.workMutate',[conversationId,`channel:${message.id}`,'appendMessage',message]);
      const content=message.modelContext?.trim()||message.content;
      append(id,{...entry,content});
      // Keep only reference metadata here; desktop transcript owns the text.
      db.prepare('UPDATE life_channel_entries SET value_json=? WHERE session_id=? AND entry_id=?').run(JSON.stringify(entry),id,entry.id);
      db.prepare('INSERT INTO life_channel_sources VALUES(?,?,?,?,?)').run(id,entry.id,conversationId,message.id,inputHash);
    });
  }, copy(from: string, to: string) {
    if (!exists(from) || exists(to)) return;
    database.transaction(() => {
      db.prepare('INSERT INTO life_channel_sessions VALUES(?)').run(to);
      db.prepare('INSERT INTO life_channel_entries(session_id,entry_id,value_json) SELECT ?,entry_id,value_json FROM life_channel_entries WHERE session_id=? ORDER BY seq').run(to, from);
      db.prepare('INSERT INTO life_channel_sources SELECT ?,entry_id,conversation_id,message_id,input_hash FROM life_channel_sources WHERE session_id=?').run(to,from);
    });
  } };
  return {...history,deliveryGet,
    deliveryAll:()=>Object.fromEntries(db.prepare('SELECT receipt_id,value_json FROM life_channel_deliveries').all().map(r=>[r.receipt_id,JSON.parse(r.value_json as string)])),
    deliverySet(key:string,value:any){return database.transaction(()=>{
      if(!['sending','failed','delivered'].includes(value?.status))throw Error('CHANNEL_RECEIPT_TRANSITION_INVALID');
      const old=deliveryGet(key);
      if(old?.fingerprint&&old.fingerprint!==value.fingerprint)throw Error('CHANNEL_MESSAGE_ID_CONFLICT');
      if(old?.status==='committed'||(old?.status==='delivered'&&value.status!=='delivered')||old?.status==='failed')throw Error('CHANNEL_RECEIPT_TRANSITION_INVALID');
      if(old?.context&&value.context&&JSON.stringify(old.context)!==JSON.stringify(value.context))throw Error('CHANNEL_RECEIPT_CONTEXT_CONFLICT');
      if(old?.prepared&&value.prepared&&JSON.stringify(old.prepared)!==JSON.stringify(value.prepared))throw Error('CHANNEL_RECEIPT_CONTENT_CONFLICT');
      db.prepare('INSERT INTO life_channel_deliveries(receipt_id,value_json) VALUES(?,?) ON CONFLICT(receipt_id) DO UPDATE SET value_json=excluded.value_json').run(key,JSON.stringify({...old,...value}));
    });},
    deliveryCommit(key:string){return database.transaction(()=>{
      const saved=deliveryGet(key);if(saved?.status==='committed')return saved.context?.boundConversationId??null;
      if(saved?.status!=='delivered')throw Error('CHANNEL_DELIVERY_NOT_CONFIRMED');
      const {incoming,context,prepared}=saved;
      if(!incoming?.messageId||!context?.sessionId||typeof prepared?.assistantText!=='string')throw Error('CHANNEL_RECEIPT_RECOVERY_METADATA_MISSING');
      const sessionId=context.sessionId.replace(/[:/\\<>:"|?*]/g,'_'),entryId=`assistant:${incoming.messageId}`;
      const at=Date.now(),entry={id:entryId,role:'assistant',at:new Date(at).toISOString()};
      if(context.boundConversationId){
        const id='channel:'+createHash('sha256').update(JSON.stringify([incoming.channel,context.sessionId,context.boundConversationId,incoming.messageId,'assistant'])).digest('hex');
        history.bind(sessionId,{conversationId:context.boundConversationId,entry,message:{id,role:'model',content:prepared.assistantText,at,
          sticker:prepared.stickerId??undefined,channelSource:{channel:incoming.channel,chatType:incoming.chatType??'private',senderName:incoming.senderName}}});
      }else if(prepared.assistantText)append(sessionId,{...entry,content:prepared.assistantText});
      db.prepare('UPDATE life_channel_deliveries SET value_json=?,session_id=?,entry_id=? WHERE receipt_id=?').run(JSON.stringify({...saved,status:'committed',at}),sessionId,entryId,key);
      return context.boundConversationId??null;
    });},
  };
}
