import { momentsStore } from './life-moments-store';
import { usageStore } from './life-usage-store';
// Isolated candidate. Existing synchronous service semantics, one SQLite writer.
import { channelHistory } from './life-channel-history';
import { isDeepStrictEqual } from 'node:util';
import type { ConversationDatabase } from './conversation-database';
const allowed = new Set(['tasks','moments','usage','channel-history','channel-delivery']);
const background = new Set(['scheduler','moments-policy','moments-reactions']);
const context = new Set(['native-call-context','native-social','native-relationship','native-proactive']);
export function serviceStateCommand(database: ConversationDatabase, method: string, args: any[]): any {
 const db=database.db;
 db.exec('CREATE TABLE IF NOT EXISTS life_service_namespaces(name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS life_service_state(namespace TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(namespace,key));');
 db.exec('CREATE TABLE IF NOT EXISTS life_startup_import(id INTEGER PRIMARY KEY CHECK(id=1),receipt_json TEXT NOT NULL);');
 db.exec('CREATE TABLE IF NOT EXISTS life_background_import(id INTEGER PRIMARY KEY CHECK(id=1),receipt_json TEXT NOT NULL);');
 db.exec('CREATE TABLE IF NOT EXISTS life_context_import(id INTEGER PRIMARY KEY CHECK(id=1),receipt_json TEXT NOT NULL);');
 if(method==='services.contextReceipt'){const row=db.prepare('SELECT receipt_json FROM life_context_import WHERE id=1').get();return row?JSON.parse(row.receipt_json as string):null;}
 if(method==='services.importContext')return database.transaction(()=>{
  const prior=serviceStateCommand(database,'services.contextReceipt',[]);if(prior)return prior;
  const {bundle,sources}=args[0];
  for(const name of context){
   if(serviceStateCommand(database,'services.initialized',[name]))continue;
   if(!Object.hasOwn(bundle,name))throw Error('CONTEXT_IMPORT_NAMESPACE_MISSING:'+name);
   serviceStateCommand(database,'services.seed',[name,bundle[name]]);
   if(!isDeepStrictEqual(serviceStateCommand(database,'services.all',[name]),bundle[name]))throw Error('CONTEXT_IMPORT_FIELDS_MISMATCH:'+name);
  }
  const receipt={version:1,complete:true,sources,at:Date.now()};
  db.prepare('INSERT INTO life_context_import VALUES(1,?)').run(JSON.stringify(receipt));return receipt;
 });
 if(method==='services.backgroundReceipt'){const row=db.prepare('SELECT receipt_json FROM life_background_import WHERE id=1').get();return row?JSON.parse(row.receipt_json as string):null;}
 if(method==='services.importBackground')return database.transaction(()=>{
  const prior=serviceStateCommand(database,'services.backgroundReceipt',[]);if(prior)return prior;
  const {bundle,sources}=args[0];
  for(const name of background){
   if(serviceStateCommand(database,'services.initialized',[name]))continue;
   if(!Object.hasOwn(bundle,name))throw Error('BACKGROUND_IMPORT_NAMESPACE_MISSING:'+name);
   serviceStateCommand(database,'services.seed',[name,bundle[name]]);
   if(!isDeepStrictEqual(serviceStateCommand(database,'services.all',[name]),bundle[name]))throw Error('BACKGROUND_IMPORT_FIELDS_MISMATCH:'+name);
  }
  const receipt={version:1,complete:true,sources,at:Date.now()};
  db.prepare('INSERT INTO life_background_import VALUES(1,?)').run(JSON.stringify(receipt));return receipt;
 });
 if(method==='services.importReceipt'){const row=db.prepare('SELECT receipt_json FROM life_startup_import WHERE id=1').get();return row?JSON.parse(row.receipt_json as string):null;}
 if(method==='services.ledgerInitialized')return !!db.prepare("SELECT 1 FROM life_service_namespaces WHERE name='execution-ledger'").get();
 if(method==='services.completeImport')return database.transaction(()=>{
  const prior=serviceStateCommand(database,'services.importReceipt',[]);if(prior)return prior;
  const {bundle,ledger,sources}=args[0];
  for(const name of allowed){
   if(serviceStateCommand(database,'services.initialized',[name])){serviceStateCommand(database,'services.all',[name]);continue;}
   if(!Object.hasOwn(bundle,name))throw Error('STARTUP_IMPORT_NAMESPACE_MISSING:'+name);
   serviceStateCommand(database,'services.seed',[name,bundle[name]]);
   const actual=serviceStateCommand(database,'services.all',[name]);
   const expected=name==='channel-history'?Object.fromEntries(Object.entries(bundle[name]).map(([id,rows])=>[id,(rows as any[]).map((row,index)=>({...row,id:row.id??`legacy:${index}`}))])):bundle[name];
   if(!isDeepStrictEqual(actual,expected))throw Error('STARTUP_IMPORT_FIELDS_MISMATCH:'+name);
  }
  if(!serviceStateCommand(database,'services.ledgerInitialized',[])){
   if(!Array.isArray(ledger))throw Error('STARTUP_IMPORT_LEDGER_MISSING');
   serviceStateCommand(database,'services.importLedger',[ledger]);
  }
  const receipt={version:1,complete:true,at:Date.now(),imported:Object.keys(bundle),namespaces:[...allowed],sources};
  db.prepare('INSERT INTO life_startup_import VALUES(1,?)').run(JSON.stringify(receipt));return receipt;
 });
 if(method==='services.importLedger')return database.transaction(()=>{
  if(db.prepare("SELECT 1 FROM life_service_namespaces WHERE name='execution-ledger'").get())return;
  for(const r of args[0])db.prepare('INSERT OR IGNORE INTO tool_operations(scope_id,operation_id,fingerprint,status,outcome_json) VALUES(?,?,?,?,?)').run(r.scope_id,r.operation_id,r.fingerprint,['started','ready'].includes(r.status)?'unknown':r.status,r.outcome_json);
  db.prepare("INSERT INTO life_service_namespaces VALUES('execution-ledger')").run();
 });
 if(method==='services.exportLedger')return db.prepare('SELECT scope_id,operation_id,fingerprint,status,outcome_json FROM tool_operations').all();
 if(method==='services.export') {
  const history=channelHistory(database);
  const out:Record<string,Record<string,unknown>>={};
  for(const r of db.prepare("SELECT name FROM life_service_namespaces WHERE name<>'execution-ledger'").all())out[r.name as string]={};
  for(const r of db.prepare('SELECT * FROM life_service_state').all())out[r.namespace as string][r.key as string]=JSON.parse(r.value_json as string);
  if(out.moments)out.moments={state:momentsStore(database).read()};
  if(out.usage)out.usage={state:usageStore(database).read()};
  if(out['channel-history'])out['channel-history']=history.all();
  if(out['channel-delivery'])out['channel-delivery']=history.deliveryAll();
  return out;
 }
 const [ns,key,value]=args;if(!allowed.has(ns)&&!background.has(ns)&&!context.has(ns))throw Error('SERVICE_NAMESPACE_INVALID');
 if(method==='services.initialized')return !!db.prepare('SELECT 1 FROM life_service_namespaces WHERE name=?').get(ns);
 if(method==='services.seed')return database.transaction(()=>{
  if(db.prepare('SELECT 1 FROM life_service_namespaces WHERE name=?').get(ns))return;
  for(const [k,v]of Object.entries(key))db.prepare('INSERT INTO life_service_state VALUES(?,?,?)').run(ns,k,JSON.stringify(v));
  db.prepare('INSERT INTO life_service_namespaces VALUES(?)').run(ns);
 });
 if(!db.prepare('SELECT 1 FROM life_service_namespaces WHERE name=?').get(ns))throw Error('SERVICE_NOT_INITIALIZED');
 if(ns==='channel-delivery'){
  const history=channelHistory(database);
  if(method==='services.get')return history.deliveryGet(key);
  if(method==='services.all')return history.deliveryAll();
  if(method==='services.set')return history.deliverySet(key,value);
  if(method==='services.deliveryCommit')return history.deliveryCommit(key);
  throw Error('CHANNEL_RECEIPT_COMMAND_INVALID');
 }
 if(ns==='moments'){
  const moments=momentsStore(database);
  if(method==='services.get'&&key==='state')return moments.read();
  if(method==='services.all')return {state:moments.read()};
  if(method==='services.momentsApply')return moments.apply(key);
  if(method==='services.momentsReserve')return moments.reserve(key);
  if(method==='services.momentsCleanup')return moments.pending();
  if(method==='services.momentsCleaned')return moments.cleaned(key);
  throw Error('MOMENTS_COMMAND_INVALID');
 }
 if(ns==='usage'){
  const usage=usageStore(database);
  if(method==='services.get'&&key==='state')return usage.read();
  if(method==='services.all')return {state:usage.read()};
  if(method==='services.usageBatch')return usage.batch(key);
  if(method==='services.usageClear')return usage.clear();
  throw Error('USAGE_COMMAND_INVALID');
 }
 if(ns==='channel-history'){
  const history=channelHistory(database);
  if(method==='services.historyAppend')return history.append(key,value);
  if(method==='services.historyBind')return history.bind(key,value);
  if(method==='services.historyRecent')return history.recent(key,value);
  if(method==='services.historyCopy')return history.copy(key,value);
  if(method==='services.get')return history.exists(key)?history.recent(key,-1):undefined;
  if(method==='services.all')return history.all();
  throw Error('CHANNEL_HISTORY_COMMAND_INVALID');
 }
 if(method==='services.get'){const r=db.prepare('SELECT value_json FROM life_service_state WHERE namespace=? AND key=?').get(ns,key);return r?JSON.parse(r.value_json as string):undefined;}
 if(method==='services.all')return Object.fromEntries(db.prepare('SELECT key,value_json FROM life_service_state WHERE namespace=?').all(ns).map(r=>[r.key,JSON.parse(r.value_json as string)]));
 if(method==='services.set'){db.prepare('INSERT INTO life_service_state VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value_json=excluded.value_json').run(ns,key,JSON.stringify(value));return;}
 throw Error('SERVICE_COMMAND_UNKNOWN');
}
