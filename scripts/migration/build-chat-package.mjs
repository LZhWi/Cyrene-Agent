import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Module, { createRequire } from 'node:module';
import { isDeepStrictEqual as equal } from 'node:util';
import { buildSync } from 'esbuild';
import { mergeRows, mergeProfiles, mergeSessions } from './merge-chat-data.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const ordinary = file => {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || path.resolve(fs.realpathSync(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw Error('Linked migration path rejected');
  return stat;
};
function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function names(directory, relative = '') {
  ordinary(path.join(directory, relative));
  return fs.readdirSync(path.join(directory, relative), {withFileTypes:true}).flatMap(entry => {
    const name = path.join(relative, entry.name), stat = ordinary(path.join(directory, name));
    if (stat.isDirectory()) return names(directory, name);
    if (!stat.isFile()) throw Error('Non-regular migration input');
    return [name];
  }).sort();
}
function loadApi() {
  const plugin = 'local-plugins/plugins/companion-memory/src/';
  const modules = ['legacy-import','dream','memory','native-history','legacy-maintenance','legacy-context-import','source-reconciliation','entity-graph','relationship-context','social-context','legacy-runtime-incremental','dmae','lifecycle','maintenance-inbox','vector-index','legacy-image-index','legacy-history-index'];
  const code = buildSync({stdin:{contents:modules.map(name=>`export * from './${plugin}${name}';`).join('\n')+"\nexport * from './src/main/chats/chat-migration-transaction';",resolveDir:project,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',target:'node24',external:['electron']}).outputFiles[0].text;
  const filename = path.join(project,'scripts/migration/api.cjs'), mod = new Module(filename);
  mod.filename = filename; mod.paths = createRequire(import.meta.url).resolve.paths('esbuild'); mod._compile(code, filename);
  return mod.exports;
}

export async function buildChatPackage({source, target, output, preferLocalRuntime = false, preferLocalImages = false}) {
  source = path.resolve(source); target = path.resolve(target); output = path.resolve(output);
  ordinary(source); ordinary(target); ordinary(path.dirname(output));
  if (fs.existsSync(output) || [source,target].some(root=>contained(root,output)||contained(output,root))) throw Error('Output must be a new directory outside both data roots');
  const api = loadApi(), selectedTarget = api.resolveChatMigrationData(target);
  const baseline = api.chatMigrationInventory(selectedTarget);
  const work = output + '.staging';
  if (fs.existsSync(work)) throw Error('Staging directory already exists; choose another output');
  fs.mkdirSync(work);
  const candidate = path.join(work,'package'), snapshot = path.join(work,'source'); fs.mkdirSync(candidate); fs.mkdirSync(snapshot);
  const observed = new Map();
  const capture = (from,to) => {
    const exists = fs.existsSync(from); if (!exists) { observed.set(from,null); return false; }
    if (!ordinary(from).isFile()) throw Error('Migration input is not a file');
    const bytes = fs.readFileSync(from), digest = hash(bytes);
    if (observed.has(from) && observed.get(from) !== digest) throw Error('Source changed while snapshotting');
    observed.set(from,digest); fs.mkdirSync(path.dirname(to),{recursive:true}); fs.writeFileSync(to,bytes); return true;
  };
  const write = (relative,value) => {const file=path.join(candidate,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
  for (const item of baseline) capture(path.join(selectedTarget,item.name),path.join(candidate,item.name));
  const sourceNames = ['memory.json','entity-graph.json','relationship-log.json','chat-social-atoms.json','memory-dream.json','phone-context-events.json','rag-data/memory-store.json','cyrene-chats/index.json'];
  const sessionNames = names(path.join(source,'cyrene-chats/sessions')).filter(name=>name.endsWith('.json')&&!name.endsWith('.last-good.json'));
  for (const name of [...sourceNames,...sessionNames.map(name=>'cyrene-chats/sessions/'+name)]) capture(path.join(source,name),path.join(snapshot,name));
  const sessionsAt = directory => fs.existsSync(path.join(directory,'cyrene-chats/sessions')) ? names(path.join(directory,'cyrene-chats/sessions')).filter(name=>name.endsWith('.json')&&!name.endsWith('.last-good.json')).map(name=>read(path.join(directory,'cyrene-chats/sessions',name))) : [];
  const sourceSessions = sessionsAt(snapshot), sessions = mergeSessions(sessionsAt(candidate), sourceSessions);
  const projected = sessions.map(session=>({id:session.id,messages:session.messages.filter(m=>['user','model','assistant'].includes(m.role)).map(m=>({...m,role:m.role==='model'?'assistant':m.role}))}));
  const conversations = {list:async()=>({items:projected.map(s=>({id:s.id}))}),getMessages:async({conversationId})=>({items:projected.find(s=>s.id===conversationId).messages.map(m=>({id:m.id,role:m.role,text:m.content,at:new Date(m.at).toISOString()}))})};
  const memoryDirectory = path.join(candidate,'plugin-data/companion-memory'); fs.mkdirSync(memoryDirectory,{recursive:true});
  const storage = {get:key=>{const file=path.join(memoryDirectory,key+'.json');return fs.existsSync(file)?read(file):undefined;},set:(key,value)=>write('plugin-data/companion-memory/'+key+'.json',value),rootDir:()=>memoryDirectory};
  const sourceFile = path.join(snapshot,'memory.json'), sourceHash = hash(fs.readFileSync(sourceFile));
  const incoming = api.createLegacyImportPlan(sourceFile,sourceHash,false,true);
  let memory = api.createMemory(storage), state = memory.view(), priorDream = incoming.compatibility.dream;
  if (!state.entries.length && !storage.get('legacy-memory-archive')) memory.importLegacy(incoming,{revision:state.revision});
  else {
    const archive = storage.get('legacy-package-source') ?? storage.get('legacy-memory-archive');
    if (!archive?.raw) throw Error('Existing memory needs an import baseline');
    const oldFile = path.join(work,'baseline/memory.json');fs.mkdirSync(path.dirname(oldFile));fs.writeFileSync(oldFile,JSON.stringify(archive.raw));
    const old = api.createLegacyImportPlan(oldFile,hash(fs.readFileSync(oldFile)),false,true);
    priorDream = old.compatibility.dream;
    const metadata = ['legacySource','provenance','turnId','sessionId','sourceEndAt','sourceAt'];
    const next = storage.get('memory-state');
    // Only an explicitly source-authoritative migration may restore absent source fields.
    // Ordinary three-way merges must preserve target-side removals.
    next.entries = mergeRows(next.entries,old.entries,incoming.entries,metadata,preferLocalRuntime ? ['conflictWith','legacySource'] : []);
    for (const row of incoming.entries) {
      const prior=old.entries.find(entry=>entry.id===row.id);
      if(prior&&(!equal(prior.content,row.content)||!equal(prior.quote,row.quote)||!equal(prior.legacySource,row.legacySource))){
        const entry=next.entries.find(entry=>entry.id===row.id);
        entry.provenance=row.provenance;entry.turnId=row.turnId;entry.sessionId=row.sessionId;
      }
    }
    next.evidence = mergeRows(next.evidence,old.evidence,incoming.evidence,metadata);
    next.profiles = mergeProfiles(next.profiles,old.profiles,incoming.profiles);next.revision++;
    storage.set('memory-state',next); memory = api.createMemory(storage);
  }
  const noModel = async()=>{throw Error('Models are forbidden during package migration');};
  const history = api.createNativeHistory({deps:{conversations,llm:{generateText:noModel}}},memory);
  for (let i=0;i<=memory.view().entries.length;i++) {
    const preview = await history.preview({conversationIds:projected.map(s=>s.id)},new AbortController().signal);
    if (!preview.unique) break;
    const applied = await history.applyUnique({previewId:preview.id},new AbortController().signal);
    if (!applied.bound) throw Error('History binding made no progress');
  }
  const maintenance = api.inspectLegacyMaintenance(read(sourceFile),projected);
  memory.restoreLegacyPending(maintenance.eligible,memory.view().revision);
  const context = api.createLegacyContextPlan(snapshot,projected), priorContext = storage.get('legacy-context-import');
  for (const [key,fresh] of Object.entries(context.states)) {
    const current = storage.get(key) ?? priorContext?.states[key];
    if (current === undefined || equal(current,fresh)) continue;
    if (key === 'entity-graph') {
      context.states[key] = {...current,entities:mergeRows(current.entities,priorContext?.states[key]?.entities??[],fresh.entities),relations:mergeRows(current.relations??[],priorContext?.states[key]?.relations??[],fresh.relations??[])};
    } else if (!equal(current,priorContext?.states[key])) throw Error('Context migration conflict: '+key);
  }
  storage.set('entity-graph',context.states['entity-graph']);
  // Once a context state has materialized, it takes precedence over the envelope.
  for (const [key,fresh] of Object.entries(context.states)) if (storage.get(key)!==undefined) storage.set(key,fresh);
  storage.set('legacy-context-import',context);
  const runtime = {dmae:incoming.runtime.dmae,lifecycle:incoming.runtime.lifecycle,inbox:incoming.compatibility.maintenanceInbox};
  const oldState=storage.get('memory-state'), prior=storage.get('legacy-runtime-baseline')?.snapshot??{dmae:oldState.legacyRuntime.dmae,lifecycle:oldState.legacyRuntime.lifecycle,inbox:oldState.legacyCompatibility.maintenanceInbox};
  const current={dmae:storage.get('dmae-state')??prior.dmae,lifecycle:storage.get('lifecycle-state')??prior.lifecycle,inbox:storage.get('maintenance-inbox')??prior.inbox};
  const runtimePlan=api.planLegacyRuntimeIncremental(prior,current,runtime,memory.view().entries,{replaceTestDmae:preferLocalRuntime});
  if (runtimePlan.conflicts.length) throw Error('Runtime migration conflicts: '+runtimePlan.conflicts.join(', '));
  for(const [key,value]of Object.entries({'dmae-state':runtimePlan.next.dmae,'lifecycle-state':runtimePlan.next.lifecycle,'maintenance-inbox':runtimePlan.next.inbox}))storage.set(key,value);
  const currentDream=storage.get('dream-state')??oldState.legacyCompatibility.dream;
  const narratives=mergeRows(currentDream.narratives,priorDream.narratives,incoming.compatibility.dream.narratives);
  storage.set('dream-state',{...currentDream,narratives,revision:currentDream.revision+(equal(currentDream.narratives,narratives)?0:1)});
  storage.set('legacy-runtime-baseline',{version:1,sourceHash,snapshot:runtimePlan.baseline});storage.set('legacy-package-source',incoming.archive);
  const vectorFile=path.join(snapshot,'rag-data/memory-store.json'),rows=read(vectorFile),vectors=api.createVectorIndex(storage);
  const vectorResult=vectors.view().imported?vectors.importLegacyIncremental(vectorFile,hash(fs.readFileSync(vectorFile)),memory.view().entries):vectors.importLegacy(vectorFile,hash(fs.readFileSync(vectorFile)),memory.entryIds());
  const historyVectors=api.migrateLegacyHistoryIndex(sessions,rows,storage.get('history-retrieval-vector-index')??{version:1,entries:{}});
  const images=api.migrateLegacyImageIndex(sourceSessions,sessions,rows,historyVectors.index,{preferSource:preferLocalImages});
  if(images.conflicts.length)throw Error('Image migration conflicts require explicit source preference');
  storage.set('history-retrieval-vector-index',images.index);
  const documents=rows.filter(row=>row.source==='imported_doc');
  const ragFile=path.join(candidate,'rag-data/memory-store.json'),existingRag=fs.existsSync(ragFile)?read(ragFile):[];
  write('rag-data/memory-store.json',mergeRows(existingRag,[],documents));
  const missingAssets=[];let copiedAssets=0;
  for(const session of images.sessions){
    for(const message of session.messages)for(const attachment of message.attachments??[]){
      if(!attachment.filePath)continue;
      const original=attachment.filePath;
      // Existing target paths refer to the source target root, not this staging copy.
      const existing=contained(selectedTarget,original)?path.join(candidate,path.relative(selectedTarget,original)):original;
      const name=hash(original)+path.extname(original),relative=contained(selectedTarget,original)?path.relative(selectedTarget,original):path.join('cyrene-chats/imported-assets',name),destination=path.join(candidate,relative);
      const available=contained(candidate,existing)?fs.existsSync(existing):capture(existing,destination);
      if(available)copiedAssets++;else missingAssets.push({sessionId:session.id,messageId:message.id});
      const outputRelative=available||contained(selectedTarget,original)?relative:path.join('cyrene-chats/missing-import-assets',name);
      attachment.filePath=path.join(output,outputRelative);attachment.previewUrl=pathToFileURL(attachment.filePath).href;
    }
    write('cyrene-chats/sessions/'+session.id+'.json',session);write('cyrene-chats/sessions/'+session.id+'.last-good.json',session);
  }
  const originalIndex=fs.existsSync(path.join(candidate,'cyrene-chats/index.json'))?read(path.join(candidate,'cyrene-chats/index.json')):[];
  const index=images.sessions.map(session=>({...session,...originalIndex.find(meta=>meta.id===session.id),messageCount:session.messages.length,updatedAt:Math.max(session.updatedAt,...session.messages.map(m=>m.at))}));
  for(const meta of index)delete meta.messages;
  write('cyrene-chats/index.json',index);write('cyrene-chats/index.last-good.json',index);
  const ttsRoot=path.join(source,'cyrene-tts-cache'),ttsNames=fs.existsSync(ttsRoot)?names(ttsRoot):[];
  const keys=new Set(sourceSessions.flatMap(s=>s.messages.map(m=>m.ttsCacheKey).filter(Boolean)));
  const referencedTtsNames=ttsNames.filter(name=>[...keys].some(key=>name.startsWith(key+'.')));
  for(const name of referencedTtsNames)capture(path.join(ttsRoot,name),path.join(candidate,'cyrene-tts-cache',name));
  if(fs.existsSync(path.join(snapshot,'phone-context-events.json'))){
    const sourceEvents=read(path.join(snapshot,'phone-context-events.json'));const targetFile=path.join(candidate,'phone-context-events.json');
    const targetEvents=fs.existsSync(targetFile)?read(targetFile):[];write('phone-context-events.json',mergeRows(targetEvents,[],sourceEvents));
  }
  const invalid=await api.findInvalidHostSources(conversations,memory.view().turns,[...memory.view().evidence,...context.sourceEvidence],new AbortController().signal);
  if(invalid.length)throw Error('Candidate contains invalid history sources');
  const ids=new Set(memory.view().entries.map(e=>e.id));for(const e of memory.view().entries)for(const id of [...(e.conflictWith??[]),...(e.subEntryIds??[]),...(e.legacySource?.parentEntryIds??[])])if(!ids.has(id))throw Error('Dangling memory relationship');
  api.createMemory(storage);api.createDream(storage);api.createDmae(storage);api.createLifecycle(storage);api.createMaintenanceInbox(storage);api.createEntityGraph(storage);api.createRelationshipLog(storage);api.createSocialContext(storage,noModel);
  for(const [file,digest]of observed)if((fs.existsSync(file)?hash(fs.readFileSync(file)):null)!==digest)throw Error('Input changed while building; package not published');
  const currentTtsNames=(fs.existsSync(ttsRoot)?names(ttsRoot):[]).filter(name=>[...keys].some(key=>name.startsWith(key+'.')));
  if(!equal(referencedTtsNames,currentTtsNames))throw Error('TTS cache changed while building; package not published');
  if(!equal(sessionNames,names(path.join(source,'cyrene-chats/sessions')).filter(name=>name.endsWith('.json')&&!name.endsWith('.last-good.json')))||!equal(baseline,api.chatMigrationInventory(api.resolveChatMigrationData(target))))throw Error('Input membership changed; package not published');
  write('migration-baseline.json',baseline);
  const manifest=names(candidate).map(name=>({name,sha256:hash(fs.readFileSync(path.join(candidate,name)))})).sort((a,b)=>a.name.localeCompare(b.name));write('manifest.json',manifest);
  fs.writeFileSync(path.join(work,'input-fingerprints.json'),JSON.stringify([...observed].map(([file,sha256])=>({file,sha256})),null,2));
  fs.renameSync(candidate,output);
  const report={output,sourceFilesChecked:observed.size,sourceMessages:sourceSessions.reduce((n,s)=>n+s.messages.length,0),targetMessages:images.sessions.reduce((n,s)=>n+s.messages.length,0),memories:memory.view().entries.length,vectors:vectorResult,historyVectors:{added:historyVectors.added,replaced:historyVectors.replaced,retained:historyVectors.retained,missing:historyVectors.missing},imageVectors:images.matched,copiedAssets,missingAssets,quarantinedQueue:maintenance.rejected,modelCalls:0,targetBaselineFiles:baseline.length};
  fs.writeFileSync(output+'.report.json',JSON.stringify(report,null,2));return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--help')){console.log('npm run migration:package -- --source=<local userData> --target=<-life userData> --output=<new package directory> [--prefer-local-runtime=true] [--prefer-local-images=true]\nReads source and target only; generates a package and report. Start the rebuilt host with --import-chat-package=<directory>; --rollback-chat-migration restores the previous generation. Models are never invoked.');process.exit(0);}
  const options={};for(const arg of process.argv.slice(2)){const split=arg.indexOf('=');if(split<0)throw Error('Use --source= --target= --output= --prefer-local-runtime=true --prefer-local-images=true');const key=arg.slice(2,split),value=arg.slice(split+1);if(!['source','target','output','prefer-local-runtime','prefer-local-images'].includes(key)||options[key]!==undefined)throw Error('Unknown or duplicate argument');options[key]=value;}
  for(const key of ['prefer-local-runtime','prefer-local-images'])if(options[key]!==undefined&&!['true','false'].includes(options[key]))throw Error('Boolean options require true or false');
  if(!options.source||!options.target||!options.output)throw Error('source, target and output are required');
  const report=await buildChatPackage({...options,preferLocalRuntime:options['prefer-local-runtime']==='true',preferLocalImages:options['prefer-local-images']==='true'});console.log(JSON.stringify(report,null,2));
}
