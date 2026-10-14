// Full application acceptance bootstrap. All fixtures and writes stay in a fresh test root.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { app, globalShortcut, session } = require('electron');
const root = path.resolve(__dirname, '../..');
const run = process.env.CYRENE_CODE_CUA_ROOT;
if (!run || path.dirname(run) !== path.join(root, 'local-plugins', '.test-runtime') || !path.basename(run).startsWith('full-code-cua-')) throw new Error('Invalid test root');
const paths = {};
for (const name of ['appData','userData','sessionData','temp','home','desktop','documents','downloads','music','pictures','videos','logs','crashDumps']) {
  paths[name] = path.join(run, name); fs.mkdirSync(paths[name], { recursive:true }); app.setPath(name, paths[name]);
}
app.setAppLogsPath(paths.logs); app.getAppPath = () => root;
app.setName('Cyrene Isolated Code Acceptance'); app.setAppUserModelId('cyrene.isolated.code-acceptance');
app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-background-networking');
os.homedir = () => paths.home; os.tmpdir = () => paths.temp;
app.setLoginItemSettings = () => {}; globalShortcut.register = () => true;
globalShortcut.unregister = () => {}; globalShortcut.unregisterAll = () => {};
require('electron').shell.openExternal = async () => { throw new Error('External launch blocked in test'); };
const log = (name, value) => fs.appendFileSync(path.join(run, name + '.jsonl'), JSON.stringify(value) + '\n');
const inside = value => { if (typeof value === 'number') return; const target = path.resolve(String(value)); if (target !== run && !target.startsWith(run + path.sep)) throw new Error('Write outside isolated test root: ' + target); };
for (const name of ['writeFileSync','appendFileSync','mkdirSync','rmSync','unlinkSync','rmdirSync','truncateSync','chmodSync']) {
  const original=fs[name]; fs[name]=function(file,...args){inside(file);return original.call(this,file,...args)};
}
for (const name of ['writeFile','appendFile','mkdir','rm','unlink','rmdir','truncate','chmod']) {
  const original=fs[name]; fs[name]=function(file,...args){inside(file);return original.call(this,file,...args)};
  const promise=fs.promises[name]; fs.promises[name]=async function(file,...args){inside(file);return promise.call(this,file,...args)};
}
for (const name of ['renameSync','copyFileSync']) { const original=fs[name];fs[name]=function(from,to,...args){if(name==='renameSync')inside(from);inside(to);return original.call(this,from,to,...args)}; }
for (const name of ['rename','copyFile']) { const original=fs.promises[name];fs.promises[name]=async function(from,to,...args){if(name==='rename')inside(from);inside(to);return original.call(this,from,to,...args)}; }
for (const name of ['openSync','open']) {const original=fs[name];fs[name]=function(file,flags,...args){if(typeof flags!=='string'||/[wa+]/.test(flags))inside(file);return original.call(this,file,flags,...args)};}
const stream=fs.createWriteStream;fs.createWriteStream=function(file,...args){inside(file);return stream.call(this,file,...args)};

globalThis.fetch = async (url, options={}) => {
  if (!String(url).includes('127.0.0.1:9/v1')) throw new Error('Network blocked in isolated test');
  const body=JSON.parse(options.body || '{}'); log('model-requests',{stream:body.stream,model:body.model,messages:body.messages});
  const text='【隔离测试回复】原生模型线路正常。';
  const chunk={id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]};
  if(body.stream) return new Response('data: '+JSON.stringify(chunk)+'\n\ndata: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  return new Response(JSON.stringify({id:'fixture',choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}),{headers:{'content-type':'application/json'}});
};
const deny=()=>{throw new Error('Network blocked in isolated test')};
for(const name of ['node:http','node:https']){require(name).request=deny;require(name).get=deny;}
require('node:net').connect=deny;require('node:net').createConnection=deny;require('node:tls').connect=deny;
app.on('ready',()=>session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_d,cb)=>cb({cancel:true})));
const cp=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
let turn=0;
cp.spawn=(exe,args=[])=>{
 if(!args.includes('app-server')){const failed=new EventEmitter();failed.stdout=new PassThrough();failed.stderr=new PassThrough();failed.stdin=new PassThrough();failed.kill=()=>true;process.nextTick(()=>failed.emit('error',new Error('Test child process blocked')));return failed;}
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.signalCode=null;
 const emit=m=>child.stdout.write(JSON.stringify(m)+'\n');let threadId='full-code-fixture',turnId;
 child.stdin=new Writable({write(chunk,_enc,cb){for(const line of chunk.toString().trim().split('\n')){
 const m=JSON.parse(line);log('codex-wire',m);if(!m.method){emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{type:'agentMessage',text:'FULL_CODE_OK：测试答案已收到。'}]}}});continue;}
 let result={};if(m.method==='account/read')result={account:{type:'chatgpt',planType:'fixture'}};
 if(m.method==='model/list')result={data:[{model:'fixture-codex',displayName:'Codex 隔离测试模型',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
 if(m.method==='skills/list')result={data:[{cwd:m.params.cwds[0],skills:[]}]};
 if(m.method==='thread/start'||m.method==='thread/resume')result={thread:{id:threadId}};
 if(m.method==='turn/start'){turnId='turn-'+(++turn);result={turn:{id:turnId}};setTimeout(()=>emit({id:'question-'+turn,method:'item/tool/requestUserInput',params:{threadId,turnId,questions:[{id:'choice',question:'请选择测试选项',options:[{label:'A'}]}]}}),100);}
 if(m.id!==undefined)emit({id:m.id,result});}cb();}});
 child.kill=()=>{log('released',{threadId,turnId});child.exitCode=0;setImmediate(()=>child.emit('exit',0));return true};return child;
};
for(const name of ['exec','execFile','fork','spawnSync','execSync','execFileSync'])cp[name]=()=>{throw new Error('Test child process blocked')};
process.on('unhandledRejection',error=>log('unhandled',{error:String(error)}));
const depsModule=require(path.join(root,'dist/main/main/application/default-dependencies.js'));
const original=depsModule.createDefaultApplicationDependencies;
depsModule.createDefaultApplicationDependencies=(...args)=>{
 const deps=original(...args);const startShell=deps.startShell;let shell;
 deps.startShell=async(...args)=>{shell=await startShell(...args);return shell};
 const background=deps.startBackground;
 deps.startBackground=async(...args)=>{
   const result=await background(...args);
   const store=require(path.join(root,'dist/main/main/chats/chats-store.js'));
   const code=store.createSession({mode:'code',title:'隔离验收 Code'});
   const workspace=path.join(run,'workspace');fs.mkdirSync(workspace,{recursive:true});
   store.setWorkspaceBinding(code.id,{workspaceRoot:workspace,displayName:'隔离验收工作区',boundAt:Date.now()});
   log('isolation',{paths,codeSessionId:code.id,workspace});
   const win=await shell.windowManager.openReactWorkspaceWindow(code.id);win.setTitle('Cyrene 原生工作区 · 隔离验收');win.show();
   return result;
 };return deps;
};
require(path.join(root,'dist/main/main/index.js'));
