// Experimental, host-only Chat adapter. No production IPC registration.
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import type { ConversationDatabase } from './conversation-database';
import { persisted } from './conversation-database';
import { runCommand } from './conversation-run-repository';
import { getMemoryTurnSource, runMemoryCommand } from './conversation-memory-repository';
import { reduceTranscriptProjection } from '../orchestrator/conversation-transcript-projection';
import type * as Chats from '../chats/chats-store-core';

export function initializeLifeChat(db: ConversationDatabase) {
  db.db.exec(`CREATE TABLE IF NOT EXISTS life_chat_operations(
    conversation_id TEXT NOT NULL REFERENCES conversations(id), operation_id TEXT NOT NULL,
    input_json TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(conversation_id,operation_id));
    CREATE TABLE IF NOT EXISTS life_chat_outbox(
    event_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    event_json TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS life_proactive_receipts(
    run_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
    message_id TEXT NOT NULL, entry_id TEXT NOT NULL, source_hash TEXT NOT NULL,
    plugin_id TEXT NOT NULL, delivered_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS life_proactive_epoch(id INTEGER PRIMARY KEY CHECK(id=1), epoch TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS life_proactive_runs(run_id TEXT PRIMARY KEY, owner_epoch TEXT NOT NULL, seal_id TEXT);
    CREATE TABLE IF NOT EXISTS life_private_sources(conversation_id TEXT NOT NULL REFERENCES conversations(id),user_turn_id TEXT NOT NULL,
      user_entry_id TEXT NOT NULL,assistant_entry_id TEXT NOT NULL,PRIMARY KEY(conversation_id,user_turn_id));`);
}
function preserveVisual(previous: any, incoming: any) {
  if (!previous?.attachments?.length || !incoming.attachments?.length) return incoming;
  return {...incoming,attachments:incoming.attachments.map((item:any)=>{
    const prior=previous.attachments.find((a:any)=>a.kind==='image' && a.filePath===item.filePath);
    return item.kind==='image' && prior ? {...item,
      visualIndexCaption:item.visualIndexCaption??prior.visualIndexCaption,
      visualIndexSummary:item.visualIndexSummary??prior.visualIndexSummary,
      visualIndexedAt:item.visualIndexedAt??prior.visualIndexedAt}:item;
  })};
}
const sourceFingerprint=(m:any)=>JSON.stringify({role:m.role,content:m.content,at:m.at,modelContext:m.modelContext,attachments:m.attachments});
const sourceHash=(m:any)=>createHash('sha256').update(sourceFingerprint({...m,attachments:m.attachments?.map((a:any)=>{
  const {visualIndexCaption:_c,visualIndexSummary:_s,visualIndexedAt:_t,...source}=a;return source;
})})).digest('hex');
const memorySourceHash=(m:any)=>JSON.stringify([sourceHash(m),m.sticker??null,m.callEvent??null,m.weatherCard??null]);
const proofHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validRunId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200;

function proactiveLifecycle(db:ConversationDatabase,chats:typeof Chats,runId:string):any {
  const receipt=db.db.prepare('SELECT * FROM life_proactive_receipts WHERE run_id=?').get(runId);
  if(receipt){
    const source=lifeChatCommand(db,chats,'life.proactiveReceiptSource',[runId]) as any;
    if(!source)return {runId,state:'invalidated',proofId:proofHash(receipt)};
    const message=chats.getSession(source.conversationId)!.messages.find(m=>m.id===source.messageId)!;
    return {runId,state:'delivered',source,delivery:{conversationId:source.conversationId,messageId:source.messageId,
      at:new Date(source.deliveredAt).toISOString(),deliveredText:message.content}};
  }
  const run=db.db.prepare('SELECT * FROM life_proactive_runs WHERE run_id=?').get(runId);
  if(run?.seal_id)return {runId,state:'abandoned',proofId:run.seal_id};
  return {runId,state:run?'inflight':'unknown'};
}

export function lifeChatCommand(db:ConversationDatabase,chats:typeof Chats,method:string,args:any[]):unknown {
  if(method==='life.runConversation')return db.db.prepare('SELECT conversation_id FROM runs WHERE run_id=?').get(args[0])?.conversation_id??null;
  if(method==='life.bindPrivateSource')return db.transaction(()=>{
    const [turn]=args,source=turn.hostSourceVersion;
    if(turn.origin!=='companion-chat'||source?.conversationId!==`private:companion-chat:${turn.sessionId}`
      ||source.userTurnId!==turn.id||!source.userEntryId||!source.assistantEntryId)throw Error('LIFE_PRIVATE_SOURCE_INVALID');
    db.ensure(source.conversationId);
    db.db.prepare('INSERT OR REPLACE INTO life_private_sources VALUES(?,?,?,?)').run(source.conversationId,source.userTurnId,source.userEntryId,source.assistantEntryId);
    return true;
  });
  if(method==='life.deleteSession')return db.transaction(()=>{
    const [id]=args,session=chats.getSession(id);if(!session)return false;
    if(session.mode!=='chat')return chats.deleteSession(id);
    chats.deleteSession(id);
    db.db.prepare('UPDATE life_chat_outbox SET delivered=2 WHERE conversation_id=? AND delivered=0').run(id);
    const eventId=`${id}:deleted:${randomUUID()}`;
    db.db.prepare('INSERT INTO life_chat_outbox(event_id,conversation_id,event_json) VALUES(?,?,?)').run(eventId,id,JSON.stringify({
      type:'host:conversation:changed',eventId,conversationId:id,reason:'conversation-deleted',allMessages:true,invalidatedMessageIds:[],timestamp:new Date().toISOString()}));
    return true;
  });
  if(method==='life.beginProactiveEpoch')return db.transaction(()=>{
    const [epoch]=args;if(!validRunId(epoch))throw Error('LIFE_INVALID_PROACTIVE_EPOCH');
    // The outer owner holds the exclusive process lock before changing epochs.
    for(const row of db.db.prepare(`SELECT run_id FROM life_proactive_runs WHERE owner_epoch<>? AND seal_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM life_proactive_receipts WHERE life_proactive_receipts.run_id=life_proactive_runs.run_id)`).all(epoch))
      db.db.prepare('UPDATE life_proactive_runs SET seal_id=? WHERE run_id=?').run(randomUUID(),row.run_id);
    db.db.prepare('INSERT OR REPLACE INTO life_proactive_epoch(id,epoch) VALUES(1,?)').run(epoch);return true;
  });
  if(method==='life.beginProactiveRun')return db.transaction(()=>{
    const [runId,epoch]=args;if(!validRunId(runId)||!validRunId(epoch))throw Error('LIFE_INVALID_PROACTIVE_RUN');
    if(db.db.prepare('SELECT epoch FROM life_proactive_epoch WHERE id=1').get()?.epoch!==epoch)throw Error('LIFE_PROACTIVE_EPOCH_STALE');
    const previous=db.db.prepare('SELECT * FROM life_proactive_runs WHERE run_id=?').get(runId);
    if(previous?.seal_id||previous&&previous.owner_epoch!==epoch||db.db.prepare('SELECT 1 FROM life_proactive_receipts WHERE run_id=?').get(runId))throw Error('LIFE_PROACTIVE_RUN_FINISHED');
    if(!previous)db.db.prepare('INSERT INTO life_proactive_runs(run_id,owner_epoch) VALUES(?,?)').run(runId,epoch);return true;
  });
  if(method==='life.proactiveLifecycle')return proactiveLifecycle(db,chats,args[0]);
  if(method==='life.sealProactiveRun')return db.transaction(()=>{
    const [runId,epoch]=args;if(!validRunId(runId)||!validRunId(epoch))throw Error('LIFE_INVALID_PROACTIVE_RUN');
    const status=proactiveLifecycle(db,chats,runId);if(status.state!=='inflight')return status;
    const run=db.db.prepare('SELECT * FROM life_proactive_runs WHERE run_id=?').get(runId);
    if(run?.owner_epoch!==epoch||db.db.prepare('SELECT epoch FROM life_proactive_epoch WHERE id=1').get()?.epoch!==epoch)throw Error('LIFE_PROACTIVE_EPOCH_STALE');
    db.db.prepare('UPDATE life_proactive_runs SET seal_id=? WHERE run_id=? AND seal_id IS NULL').run(randomUUID(),runId);
    return proactiveLifecycle(db,chats,runId);
  });
  if(method==='life.promptLifecycle'){
    const [conversationId,runId]=args,base={conversationId,runId};
    const run=db.db.prepare('SELECT conversation_id,status,record_json FROM runs WHERE run_id=?').get(runId);
    if(!run||run.conversation_id!==conversationId)return {...base,state:'unknown'};
    if(['failed','cancelled','interrupted'].includes(run.status as string))return {...base,state:'terminal',status:run.status,proofId:proofHash(run)};
    return {...base,state:run.status==='completed'?'completed':['prepared','running'].includes(run.status as string)?'inflight':'unknown'};
  }
  if(method==='life.proactiveReceiptExists')return !!db.db.prepare('SELECT 1 FROM life_proactive_receipts WHERE run_id=?').get(args[0]);
  if(method==='life.proactiveReceiptSource') {
    const row=db.db.prepare('SELECT * FROM life_proactive_receipts WHERE run_id=?').get(args[0]);
    if(!row)return null;
    const session=chats.getSession(row.conversation_id as string);
    const message=session?.messages.find(m=>m.id===row.message_id&&m.role==='model');
    const node=reduceTranscriptProjection(db.entries(row.conversation_id as string,true)).state?.nodes
      .find(n=>n.kind==='assistant'&&(n.turnId??n.messageId)===row.message_id);
    if(session?.mode!=='chat'||!message||!node||sourceHash(message)!==row.source_hash
      ||(node.memoryEntryId??node.entryId)!==row.entry_id)return null;
    return {runId:row.run_id,pluginId:row.plugin_id,conversationId:row.conversation_id,
      messageId:row.message_id,assistantEntryId:row.entry_id,status:'delivered',deliveredAt:Number(row.delivered_at)};
  }
  if(method==='life.appendProactiveMessage')return db.transaction(()=>{
    const [id,input]=args;
    if(typeof input?.runId!=='string'||!input.runId||input.runId.length>200
      ||input.pluginId!=='companion-chat'||typeof input.text!=='string'||!input.text.trim()||input.text.length>32000
      ||!Number.isFinite(input.at)||input.at<0)throw Error('LIFE_INVALID_PROACTIVE_DELIVERY');
    const existing=db.db.prepare('SELECT * FROM life_proactive_receipts WHERE run_id=?').get(input.runId);
    if(existing){
      const source=lifeChatCommand(db,chats,'life.proactiveReceiptSource',[input.runId]) as any;
      const message=source&&chats.getSession(source.conversationId)?.messages.find(m=>m.id===source.messageId);
      if(!source||source.conversationId!==id||source.pluginId!==input.pluginId||message?.content!==input.text)
        throw Error('LIFE_PROACTIVE_DELIVERY_CONFLICT');
      return {conversationId:id,messageId:source.messageId,at:new Date(source.deliveredAt).toISOString()};
    }
    if(db.db.prepare('SELECT seal_id FROM life_proactive_runs WHERE run_id=?').get(input.runId)?.seal_id)throw Error('LIFE_PROACTIVE_RUN_SEALED');
    const session=chats.getSession(id);
    if(session?.mode!=='chat'||session.purpose!=='proactive-chat')throw Error('LIFE_PROACTIVE_CHAT_REQUIRED');
    const message={id:randomUUID(),role:'model',content:input.text,at:input.at,
      pluginDelivery:{pluginId:input.pluginId,...(input.allowIgnoreFeedback?{ignoreFeedback:'pending'}:{})}};
    lifeChatCommand(db,chats,'life.mutate',[id,`proactive:${input.runId}`,'appendMessage',message]);
    const node=reduceTranscriptProjection(db.entries(id,true)).state?.nodes
      .find(n=>n.kind==='assistant'&&(n.turnId??n.messageId)===message.id);
    if(!node)throw Error('LIFE_PROACTIVE_SOURCE_MISSING');
    db.db.prepare('INSERT INTO life_proactive_receipts VALUES(?,?,?,?,?,?,?)').run(input.runId,id,message.id,
      node.memoryEntryId??node.entryId,sourceHash(message),input.pluginId,input.at);
    return {conversationId:id,messageId:message.id,at:new Date(input.at).toISOString()};
  });
  if(method==='life.promptSource') {
    const [conversationId,runId]=args;
    const run=db.db.prepare('SELECT conversation_id,status FROM runs WHERE run_id=?').get(runId);
    const request=db.db.prepare('SELECT dispatch_json FROM conversation_requests WHERE run_id=?').get(runId);
    const facts=request?.dispatch_json?JSON.parse(request.dispatch_json as string):null;
    if(run?.conversation_id!==conversationId||!facts?.currentUser?.turnId||!facts?.assistantTurnId)return null;
    const session=chats.getSession(conversationId);
    if(session?.mode!=='chat')return null;
    const user=session.messages.find(m=>m.id===facts.currentUser.turnId&&m.role==='user');
    if(!user||(user.modelContext?.trim()||user.content)!==facts.currentUser.text)return null;
    const nodes=reduceTranscriptProjection(db.entries(conversationId,true)).state?.nodes??[];
    const node=nodes.find(n=>n.kind==='user'&&(n.turnId??n.messageId)===user.id);
    if(!node)return null;
    const completed=getMemoryTurnSource(db,conversationId,user.id);
    const assistant=nodes.find(n=>n.kind==='assistant'&&(n.turnId??n.messageId)===facts.assistantTurnId);
    if(run.status==='completed'){
      const delivery=db.db.prepare('SELECT event_json FROM life_chat_outbox WHERE event_id=?').get(`${conversationId}:turn:${runId}`);
      const committed=delivery?JSON.parse(delivery.event_json as string).memorySource:null;
      if(!committed||!completed||!isDeepStrictEqual(committed,completed))return null;
    }
    return {conversationId,runId,userTurnId:user.id,assistantTurnId:facts.assistantTurnId,
      userEntryId:node.memoryEntryId??node.entryId,status:run.status,
      ...(completed&&assistant&&completed.assistantEntryId===(assistant.memoryEntryId??assistant.entryId)?{assistantEntryId:completed.assistantEntryId}:{})};
  }
  if(method==='life.beginSubscribedTurn')return db.transaction(()=>{
    const result=lifeChatCommand(db,chats,'life.beginTurn',args);
    lifeChatCommand(db,chats,'life.queueSubscriberSignal',[args[0],`start:${args[1]}`,{type:'host:turn:started',runId:args[1]}]);
    return result;
  });
  if(method==='life.finishNativeTurn')return db.transaction(()=>{
    const [event]=args,id=event.conversationId,runId=event.runId;
    const source=lifeChatCommand(db,chats,'life.promptSource',[id,runId]) as any;
    if(!source)return false;
    if(['cancelled','failed','interrupted'].includes(source.status))return false;
    const eventId=`${id}:turn:${runId}`;
    if(db.db.prepare('SELECT 1 FROM life_chat_outbox WHERE event_id=?').get(eventId))return true;
    if(event.source!=='desktop'||event.mode!=='chat')throw Error('LIFE_NATIVE_EVENT_SCOPE');
    if(event.status==='success'){
      const message=chats.getSession(id)?.messages.find(m=>m.id===event.finalMessageId&&m.role==='model');
      if(event.inputMessageId!==source.userTurnId||event.finalMessageId!==source.assistantTurnId||!message)throw Error('LIFE_COMPLETION_SOURCE_MISMATCH');
      lifeChatCommand(db,chats,'life.mutate',[id,`native:${runId}`,'completeTurn',{
        runId,inputMessageId:event.inputMessageId,message,companionLifeUpdate:event.companionLifeUpdate,
        timezone:event.timezone,durationMs:event.durationMs,
      }]);return true;
    }
    if(!['cancelled','timeout','runtime_error'].includes(event.status))throw Error('LIFE_NATIVE_STATUS_INVALID');
    if(!['prepared','running'].includes(source.status))throw Error('LIFE_NATIVE_RUN_FINISHED');
    runCommand(db,'runs.terminal',[runId,event.status==='cancelled'?'cancelled':'failed']);
    db.db.prepare('INSERT INTO life_chat_outbox(event_id,conversation_id,event_json) VALUES(?,?,?)').run(eventId,id,JSON.stringify({
      type:'host:turn:finished',eventId,timestamp:new Date().toISOString(),conversationId:id,runId,
      source:'desktop',mode:'chat',chatBackend:'companion',inputMessageId:source.userTurnId,status:event.status,
    }));return true;
  });
  // Host-only signal; the admitted run and exact source must already exist.
  if(method==='life.queueSubscriberSignal')return db.transaction(()=>{
    const [id,key,signal]=args;
    if(typeof key!=='string'||!key||!signal||!['host:turn:started','host:prompt:accepted'].includes(signal.type)
      ||typeof signal.runId!=='string'||(signal.type==='host:prompt:accepted'&&(!['plugin:companion-chat:worldbook','plugin:companion-memory:memory-context'].includes(signal.providerId)||typeof signal.complete!=='boolean')))
      throw Error('LIFE_INVALID_SUBSCRIBER_SIGNAL');
    const run=db.db.prepare('SELECT conversation_id FROM runs WHERE run_id=?').get(signal.runId);
    const request=db.db.prepare('SELECT dispatch_json FROM conversation_requests WHERE run_id=?').get(signal.runId);
    const facts=request?.dispatch_json?JSON.parse(request.dispatch_json as string):null;
    const user=chats.getSession(id)?.messages.find(m=>m.id===facts?.currentUser?.turnId&&m.role==='user');
    if(run?.conversation_id!==id||!user)throw Error('LIFE_SIGNAL_SOURCE_MISMATCH');
    const eventId=`${id}:signal:${key}`,event={type:signal.type,runId:signal.runId,conversationId:id,source:'desktop',mode:'chat',chatBackend:'companion',
      ...(signal.type==='host:prompt:accepted'?{providerId:signal.providerId,complete:signal.complete}:{}),_sources:{[user.id]:sourceHash(user)}};
    const previous=db.db.prepare('SELECT event_json FROM life_chat_outbox WHERE event_id=?').get(eventId);
    if(previous){const {timestamp:_t,eventId:_e,...old}=JSON.parse(previous.event_json as string);if(!isDeepStrictEqual(old,event))throw Error('LIFE_SIGNAL_CONFLICT');return eventId;}
    db.db.prepare('INSERT INTO life_chat_outbox(event_id,conversation_id,event_json) VALUES(?,?,?)')
      .run(eventId,id,JSON.stringify({...event,eventId,timestamp:new Date().toISOString()}));return eventId;
  });
  if(method==='life.memorySource')return getMemoryTurnSource(db,args[0],args[1]);
  if(method==='life.recordMemoryTurn')return db.transaction(()=>{
    const [turn,legacyCount=0]=args;
    const current=getMemoryTurnSource(db,turn.conversationId,turn.userTurnId);
    if(!current||current.userEntryId!==turn.userEntryId||current.assistantEntryId!==turn.assistantEntryId)
      throw Error('LIFE_MEMORY_SOURCE_STALE');
    return runMemoryCommand(db,'memory.record',[turn,legacyCount]);
  });
  if(method==='life.importMemoryQueue')return db.transaction(()=>{
    // Isolated bootstrap only. Replaying the same committed snapshot cannot un-consume a row.
    for(const turn of args[0]){
      const source=getMemoryTurnSource(db,turn.conversationId,turn.userTurnId);
      if(!source||source.userEntryId!==turn.userEntryId||source.assistantEntryId!==turn.assistantEntryId)throw Error('LIFE_MEMORY_SOURCE_STALE');
      const result=runMemoryCommand(db,'memory.record',[turn,0]) as {seq?:number};
      if(turn.processed)db.db.prepare('UPDATE memory_pending_turns SET processed=1 WHERE seq=?').run(result.seq!);
    }
    for(const id of new Set(args[0].map((t:any)=>t.conversationId))){
      db.db.prepare(`UPDATE memory_pending_turns SET payload_json=NULL WHERE conversation_id=? AND processed=1
        AND seq NOT IN (SELECT seq FROM memory_pending_turns WHERE conversation_id=? AND active=1 AND processed=1 ORDER BY seq DESC LIMIT 2)`).run(id as string,id as string);
    }
    return true;
  });
  if(method==='life.beginTurn') {
    const [id,runId,message]=args;
    return db.transaction(()=>{
      if(chats.getSession(id)?.mode!=='chat'||message?.role!=='user')throw Error('LIFE_CHAT_ONLY');
      const current=chats.getSession(id)?.messages.find(m=>m.id===message.id);
      if(current && sourceHash(current)!==sourceHash(message))throw Error('LIFE_BEGIN_SOURCE_MISMATCH');
      const facts={mode:'chat',assistantTurnId:args[3],currentUser:{turnId:message.id,text:message.modelContext?.trim()||message.content,visibleContent:message.content}};
      if(!current)lifeChatCommand(db,chats,'life.mutate',[id,`begin:${runId}`,'appendMessage',message]);
      return runCommand(db,'runs.admit',[id,`life:${runId}`,facts,runId,[]]);
    });
  }
  if(method==='life.pendingEvents') return db.transaction(()=>db.db.prepare('SELECT event_id,event_json FROM life_chat_outbox WHERE delivered=0 ORDER BY rowid').all()
    .flatMap(row=>{
      const {_sources,...event}=JSON.parse(row.event_json as string);
      if(event.memorySource){
        const current=getMemoryTurnSource(db,event.conversationId,event.inputMessageId);
        if(!current||current.userEntryId!==event.memorySource.userEntryId||current.assistantEntryId!==event.memorySource.assistantEntryId){
          db.db.prepare('UPDATE life_chat_outbox SET delivered=2 WHERE event_id=?').run(row.event_id!);return [];
        }
      }
      if(_sources){
        const messages=chats.getSession(event.conversationId)?.messages??[];
        if(Object.entries(_sources).some(([id,hash])=>{const m=messages.find(m=>m.id===id);return !m||sourceHash(m)!==hash;})){
          db.db.prepare('UPDATE life_chat_outbox SET delivered=2 WHERE event_id=?').run(row.event_id!);return [];
        }
      }
      return [{id:row.event_id,event}];
    }));
  if(method==='life.eventLifecycle') {
    // Apply the same exact-source retirement rules used by outbox delivery.
    lifeChatCommand(db,chats,'life.pendingEvents',[]);
    const row=db.db.prepare('SELECT delivered FROM life_chat_outbox WHERE event_id=?').get(args[0]);
    return {eventId:args[0],state:!row?'unknown':row.delivered===2?'invalidated':row.delivered===1?'delivered':'pending'};
  }
  if(method==='life.ackEvent') { db.db.prepare('UPDATE life_chat_outbox SET delivered=1 WHERE event_id=? AND delivered=0').run(args[0]);return; }
  if(method!=='life.mutate'&&method!=='life.workMutate') throw Error('LIFE_UNKNOWN_COMMAND');
  const work=method==='life.workMutate';
  const [id,operationId,name,rawArgs]=args;
  if(typeof operationId!=='string'||!operationId)throw Error('LIFE_OPERATION_ID_REQUIRED');
  const input=persisted({name,args:rawArgs}),raw=input.args;
  return db.transaction(()=>{
    const duplicate=db.db.prepare('SELECT input_json,result_json FROM life_chat_operations WHERE conversation_id=? AND operation_id=?').get(id,operationId);
    if(duplicate){if(!isDeepStrictEqual(JSON.parse(duplicate.input_json as string),input))throw Error('LIFE_OPERATION_CONFLICT');return JSON.parse(duplicate.result_json as string);}
    const session=chats.getSession(id);
    if(!session)return null;
    if(work?!['work','code','learn'].includes(session.mode??''):session.mode!=='chat')throw Error('LIFE_MODE_MISMATCH');
    if(work&&['completeTurn','markPluginMessageIgnored'].includes(name))throw Error('LIFE_WORK_OPERATION_REJECTED');
    const history=db.entries(id,true);
    if(!work&&history.some(e=>['tool_result','tool_started'].includes(e.kind)))throw Error('LIFE_UNSUPPORTED_TOOL_TRANSCRIPT');
    const before=session.messages as any[];let after=structuredClone(before),quiet=false,result:any;
    const previous=new Map(before.map(m=>[m.id,m]));
    const put=(m:any)=>{const index=after.findIndex(x=>x.id===m.id);const saved=preserveVisual(previous.get(m.id),m);if(index<0)after.push(saved);else after[index]=saved;};
    if(name==='appendMessage') {
      if(previous.has(raw.id)) {if(!isDeepStrictEqual(previous.get(raw.id),raw))throw Error('LIFE_MESSAGE_ID_CONFLICT');}
      else put(raw);
    } else if(name==='upsertMessage')put(raw);
    else if(name==='replaceMessages'||name==='replaceMessagesTail') {
      const start=name==='replaceMessages'?0:raw.startIndex,items=name==='replaceMessages'?raw:raw.messages;
      if(name==='replaceMessagesTail') {
        if(!Number.isInteger(start)||start<0||start>after.length)return null;
        if(raw.expectedTailIds&&(after.length-start!==raw.expectedTailIds.length
          ||raw.expectedTailIds.some((messageId:string,index:number)=>after[start+index].id!==messageId)))return null;
      }
      if(!Number.isInteger(start)||start<0||start>after.length||!Array.isArray(items))throw Error('LIFE_INVALID_REPLACEMENT');
      after=after.slice(0,start).concat(items.map((m:any)=>preserveVisual(previous.get(m.id),m)));
    } else if(name==='deleteMessageRound') {
      const index=after.findIndex(m=>m.id===raw.messageId);if(index<0)return null;
      let start=index,end=index+1;
      if(after[index].role==='model'&&after[index-1]?.role==='user'&&!after[index-1].musicEvent)start--;
      else if(after[index].role==='user'&&!after[index].musicEvent&&after[index+1]?.role==='model')end++;
      after.splice(start,end-start);
    } else if(name==='setMessageTtsCacheKey') {
      if(!/^(minimax|gptsovits|custom-cloud|mimo|mossland)-[a-f0-9]{64}$/.test(raw.cacheKey)
        ||!/^[a-z\d][a-z\d._-]{0,63}$/i.test(raw.converterVersion))return null;
      const message=after.find(m=>m.id===raw.messageId&&m.role==='model');if(!message)return null;
      message.ttsCacheKey=raw.cacheKey;message.ttsCacheVersion=raw.converterVersion;quiet=true;
    } else if(name==='setImageVisualIndexResult') {
      const message=after.find(m=>m.id===raw.messageId&&m.role==='user');
      const image=message?.attachments?.find((a:any)=>a.kind==='image'&&a.filePath===raw.filePath);
      if(!image)return false;
      if(typeof raw.result?.summary!=='string'||!raw.result.summary.trim())throw Error('LIFE_INVALID_VISUAL_RESULT');
      image.visualIndexSummary=raw.result.summary;if(raw.result.caption)image.visualIndexCaption=raw.result.caption;
      image.visualIndexedAt??=Date.now();quiet=true;result=true;
    } else if(name==='markPluginMessageIgnored') {
      const m=after.at(-1);if(session.purpose!=='proactive-chat'||m?.id!==raw.messageId||m.role!=='model'||m.pluginDelivery?.ignoreFeedback!=='pending')return null;
      m.pluginDelivery.ignoreFeedback='ignored';result={pluginId:m.pluginDelivery.pluginId};
    } else if(name==='completeTurn') {
      const run=db.db.prepare('SELECT conversation_id,status FROM runs WHERE run_id=?').get(raw.runId);
      const request=db.db.prepare('SELECT dispatch_json FROM conversation_requests WHERE run_id=?').get(raw.runId);
      const facts=request?.dispatch_json?JSON.parse(request.dispatch_json as string):null;
      const user=before.find(m=>m.id===raw.inputMessageId&&m.role==='user');
      if(!run||run.conversation_id!==id||!['prepared','running'].includes(run.status as string)||!user
        ||facts?.currentUser?.turnId!==raw.inputMessageId||facts.assistantTurnId!==raw.message?.id||raw.message?.role!=='model'
        ||(user.modelContext?.trim()||user.content)!==facts.currentUser.text)throw Error('LIFE_COMPLETION_SOURCE_MISMATCH');
      put(raw.message);
    } else throw Error('LIFE_UNKNOWN_MUTATION');
    if(new Set(after.map(m=>m.id)).size!==after.length)throw Error('LIFE_DUPLICATE_MESSAGE_ID');
    const removed=before.filter(m=>!after.some(n=>n.id===m.id)).map(m=>m.id);
    const changed=after.filter(m=>!isDeepStrictEqual(previous.get(m.id),m));
    if(changed.length||removed.length||JSON.stringify(before.map(m=>m.id))!==JSON.stringify(after.map(m=>m.id))) {
      const nodes=reduceTranscriptProjection(history).state?.nodes??[];
      const memorySourceIds:Record<string,string>={};
      for(const message of changed){
        const prior=previous.get(message.id),node=nodes.find(n=>(n.turnId??n.messageId)===message.id);
        if(prior&&node&&memorySourceHash(prior)===memorySourceHash(message))memorySourceIds[message.id]=node.memoryEntryId??node.entryId;
      }
      db.append(id,{id:`life:${operationId}`,at:Date.now(),...(name==='completeTurn'?{runId:raw.runId}:{}),kind:work?'life_work_mutation':'life_chat_mutation',payload:{messages:changed,removeIds:removed,orderIds:after.map(m=>m.id),memorySourceIds}});
    }
    const record=db.record(id)! as any;record.messageCount=after.length;
    if(!quiet&&!record.titleIsCustom&&name!=='markPluginMessageIgnored'){
      const first=after.find(m=>m.role==='user'&&m.content.trim());const title=first?.content.replace(/\s+/g,' ').trim()??'';
      record.title=title?(title.length>30?title.slice(0,30)+'…':title):'新对话';
    }
    if(!quiet)record.updatedAt=Date.now();db.saveRecord(record);
    const next=chats.getSession(id)!;
    const invalidated=before.filter(m=>{const n=after.find(n=>n.id===m.id);return !n||memorySourceHash(m)!==memorySourceHash(n);}).map(m=>m.id);
    if(!work&&invalidated.length){
      const ids=new Set(invalidated);
      for(const row of db.db.prepare("SELECT r.run_id,q.dispatch_json FROM runs r JOIN conversation_requests q ON q.run_id=r.run_id WHERE r.conversation_id=? AND r.status IN ('prepared','running')").all(id)){
        const facts=row.dispatch_json?JSON.parse(row.dispatch_json as string):null;
        // Editing/deleting the source retires an undelivered run. Its late ack
        // cannot resurrect the removed answer or block the next generation.
        if(ids.has(facts?.currentUser?.turnId)||removed.includes(facts?.assistantTurnId))runCommand(db,'runs.terminal',[row.run_id,'cancelled']);
      }
    }
    const enqueue=(key:string,event:object)=>db.db.prepare('INSERT INTO life_chat_outbox(event_id,conversation_id,event_json) VALUES(?,?,?)')
        .run(`${id}:${key}`,id,JSON.stringify({...event,eventId:`${id}:${key}`,timestamp:new Date().toISOString()}));
    if(!work&&invalidated.length)enqueue(operationId,{type:'host:conversation:changed',conversationId:id,
      reason:name==='deleteMessageRound'?'message-round-deleted':'messages-replaced',allMessages:false,invalidatedMessageIds:invalidated});
    if(name==='completeTurn'){
      runCommand(db,'runs.terminal',[raw.runId,'completed']);
      enqueue(`turn:${raw.runId}`,{type:'host:turn:finished',source:'desktop',runId:raw.runId,mode:'chat',chatBackend:'companion',
        conversationId:id,inputMessageId:raw.inputMessageId,finalMessageId:raw.message.id,status:'success',
        ...(raw.timezone?{timezone:raw.timezone}:{}),...(raw.durationMs!==undefined?{durationMs:raw.durationMs}:{}),
        ...(raw.companionLifeUpdate?{companionLifeUpdate:raw.companionLifeUpdate}:{}),
        memorySource:getMemoryTurnSource(db,id,raw.inputMessageId),
        _sources:{[raw.inputMessageId]:sourceHash(after.find(m=>m.id===raw.inputMessageId)),[raw.message.id]:sourceHash(after.find(m=>m.id===raw.message.id))}});
    }
    if(name==='markPluginMessageIgnored'&&result?.pluginId)enqueue(`feedback:${operationId}`,{
      type:'host:assistant-message:feedback',pluginId:result.pluginId,conversationId:id,messageId:raw.messageId,action:'ignore',
      _sources:{[raw.messageId]:sourceHash(after.find(m=>m.id===raw.messageId))}});
    const output=name==='markPluginMessageIgnored'?{...result,session:next}:result??next;
    db.db.prepare('INSERT INTO life_chat_operations VALUES(?,?,?,?)').run(id,operationId,JSON.stringify(input),JSON.stringify(output));
    return output;
  });
}
