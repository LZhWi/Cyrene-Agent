// Startup-only import. Existing SQLite namespaces are authoritative, including empty ones.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {plain}=require('./data-boundary.cjs');
function importServices(profile,call){
 const sources={},bundle={};
 function read(relative,fallback){const file=plain(path.join(profile,relative));if(!fs.existsSync(file)){sources[relative]=null;return fallback;}const bytes=fs.readFileSync(file);sources[relative]=crypto.createHash('sha256').update(bytes).digest('hex');return JSON.parse(bytes.toString('utf8'));}
 function directory(relative,suffix,parse){const dir=plain(path.join(profile,relative));const result={};if(fs.existsSync(dir))for(const name of fs.readdirSync(dir).filter(n=>n.endsWith(suffix)).sort()){const rel=path.join(relative,name),file=plain(path.join(profile,rel));const bytes=fs.readFileSync(file);sources[rel]=crypto.createHash('sha256').update(bytes).digest('hex');result[name.slice(0,-suffix.length)]=parse(bytes.toString('utf8'));}return result;}
 if(!call('harness.importReceipt')){
  const records=directory('cyrene-runs/sessions','.json',JSON.parse);
  const events=directory('cyrene-runs/sessions','.events.jsonl',text=>text.split(/\r?\n/).filter(line=>line.trim()).map(JSON.parse));
  call('harness.importLegacy',{records,events,sources:{...sources}});
 }
 if(!call('services.backgroundReceipt')){
  const scheduled=read('scheduled-tasks.json',{tasks:[]}),policy=read('moments-state.json',{}),reactions=read('moments-reaction-queue.json',{tasks:[]});
  const historyFile=plain(path.join(profile,'scheduled-tasks-history.jsonl'));
  let history=[];sources['scheduled-tasks-history.jsonl']=null;
  if(fs.existsSync(historyFile)){const bytes=fs.readFileSync(historyFile);sources['scheduled-tasks-history.jsonl']=crypto.createHash('sha256').update(bytes).digest('hex');history=bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);}
  if(!Array.isArray(scheduled?.tasks)||!Array.isArray(reactions?.tasks)||!policy||typeof policy!=='object'||Array.isArray(policy))throw Error('BACKGROUND_IMPORT_INVALID');
  call('services.importBackground',{bundle:{scheduler:{tasks:scheduled,history},'moments-policy':{state:policy},'moments-reactions':{state:reactions}},sources:{...sources}});
 }
 if(!call('services.contextReceipt')){
  const calls=read('phone-context-events.json',[]),social=read('chat-social-atoms.json',{schemaVersion:1,atoms:[]}),relationship=read('relationship-log.json',{entries:[],dailySummaries:[]}),proactive=read('proactive-state.json',{});
  if(!Array.isArray(calls)||!Array.isArray(social?.atoms)||!Array.isArray(relationship?.entries)||!Array.isArray(relationship?.dailySummaries)||!proactive||typeof proactive!=='object'||Array.isArray(proactive))throw Error('CONTEXT_IMPORT_INVALID');
  call('services.importContext',{bundle:{'native-call-context':{state:calls},'native-social':{state:social},'native-relationship':{state:relationship},'native-proactive':{state:proactive}},sources:{...sources}});
 }
 if(call('services.importReceipt'))return call('services.importReceipt');
 for(const name of ['tasks','usage','moments','channel-history','channel-delivery']){
  if(call('services.initialized',name))continue;
  if(name==='tasks'){bundle[name]=directory('cyrene-tasks/sessions','.json',JSON.parse);for(const [id,row]of Object.entries(bundle[name]))if(row.id!==id||row.schemaVersion!==1||!['parentConversationId','parentRunId','childRunId','description'].every(k=>typeof row[k]==='string')||!['general','document','search'].includes(row.subagentType)||!['work','code'].includes(row.mode)||!['running','completed','failed','cancelled','interrupted'].includes(row.status)||typeof row.createdAt!=='number'||typeof row.updatedAt!=='number'||!Array.isArray(row.messages)||!Array.isArray(row.trace))throw Error('TASK_IMPORT_INVALID:'+id);}
  if(name==='usage'){const value=read('token-usage.json',{});if(value.days!==undefined&&(!value.days||typeof value.days!=='object'||Array.isArray(value.days)))throw Error('USAGE_IMPORT_INVALID');bundle[name]={state:{...value,schemaVersion:2,days:value.days??{}}};}
  if(name==='moments'){const value=read('moments.json',{schemaVersion:2,posts:[],comments:[],reactions:[]});for(const key of ['posts','comments','reactions'])if(!Array.isArray(value[key]))throw Error('MOMENTS_IMPORT_INVALID');bundle[name]={state:value};}
  if(name==='channel-history')bundle[name]=directory('channels/history','.jsonl',text=>text.split('\n').filter(Boolean).map(JSON.parse));
  if(name==='channel-delivery')bundle[name]=read('channel-delivery.json',{});
 }
 const ledger=call('services.ledgerInitialized')?undefined:read('execution-ledger.json',[]);
 if(ledger!==undefined&&!Array.isArray(ledger))throw Error('LEDGER_IMPORT_INVALID');
 return call('services.completeImport',{bundle,ledger,sources});
}
module.exports={importServices};
