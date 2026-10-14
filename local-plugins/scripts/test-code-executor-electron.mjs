import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manual = process.argv.includes("--manual");
const run = path.join(root, "local-plugins/.test-runtime", `native-code-${Date.now()}`);
await mkdir(run, { recursive: true });
await build({ entryPoints: [path.join(root, "src/main/chats/code-executor-ipc.ts")], bundle: true, platform: "node", outfile: path.join(run, "ipc.cjs") });
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {CodeExecutorSurface,useCodeExecutorRoute} from './src/renderer/react/features/chat/components/CodeExecutorSurface';
function Native(){return React.createElement(React.Fragment,null,useCodeExecutorRoute(),React.createElement("button",{id:"native-send",onClick:e=>{globalThis.nativeSends++;e.currentTarget.textContent="原生发送已触发 "+globalThis.nativeSends+" 次"}},"原生发送（模拟）"))};globalThis.nativeSends=0; createRoot(document.getElementById('root')).render(React.createElement(CodeExecutorSurface,{enabled:true,sessionId:'code-test',workspace:${JSON.stringify(run)},nativeBusy:false,onChooseWorkspace:()=>{},children:React.createElement(Native)}));`, resolveDir: root, loader: "tsx" }, bundle: true, platform: "browser", jsx: "automatic", outfile: path.join(run, "ui.js") });
await writeFile(path.join(run, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script>');
await writeFile(path.join(run, "preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('codeExecutor',{invoke:(...args)=>ipcRenderer.invoke('code-executor:invoke',...args)});`);
await writeFile(path.join(run, "host.cjs"), `
const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough,Writable}=require('node:stream');
app.disableHardwareAcceleration();app.setPath('userData',path.join(__dirname,'userData'));app.setPath('sessionData',path.join(__dirname,'sessionData'));app.setPath('logs',path.join(__dirname,'logs'));
const wire=[],cleanups=[],stored=new Map(),abort=new AbortController();let killed=0,summaryCalls=0;
require('node:child_process').spawn=()=>{
 const child=new EventEmitter();child.exitCode=null;child.signalCode=null;child.stdout=new PassThrough();child.stderr=new PassThrough();
 const emit=msg=>child.stdout.write(JSON.stringify(msg)+'\\n');
 child.stdin=new Writable({write(chunk,_enc,cb){for(const line of chunk.toString().trim().split('\\n')){
 const m=JSON.parse(line);wire.push(m);fs.writeFileSync(path.join(__dirname,'wire.json'),JSON.stringify(wire,null,2));if(!m.method){assert.deepEqual(m.result,{answers:{q:{answers:['A']}}});emit({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'NATIVE_CODE_OK'}]}}});continue;}
  let result={};
  if(m.method==='account/read')result={account:{type:'chatgpt'}};
  if(m.method==='model/list')result={data:[{model:'test',isDefault:true,defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]}]};
  if(m.method==='skills/list')result={data:[{cwd:__dirname,skills:[]}]};
  if(m.method==='thread/start')result={thread:{id:'thread'}};
  if(m.method==='turn/start'){${manual ? "" : "assert.equal(m.params.input[0].text,'  原生界面原文  ');"}result={turn:{id:'turn'}};setTimeout(()=>emit({id:'q1',method:'item/tool/requestUserInput',params:{threadId:'thread',turnId:'turn',questions:[{id:'q',question:'确认选项',options:[{label:'A'}]}]}}),50);}
  if(m.id!==undefined)emit({id:m.id,result});
 }cb();}});child.kill=()=>{killed++;fs.writeFileSync(path.join(__dirname,'released.json'),JSON.stringify({killed}));setImmediate(()=>child.emit('exit',0));return true;};return child;
};
const plugin=require(${JSON.stringify(path.join(root, "local-plugins/artifacts/codex-bridge/index.cjs"))});
const handlers=new Map();plugin.register({id:'codex-bridge',signal:abort.signal,onDispose:fn=>cleanups.push(fn),storage:{rootDir:()=>__dirname,get:key=>stored.get(key),set:(key,value)=>stored.set(key,structuredClone(value))},deps:{llm:{generateText:async()=>{summaryCalls++;return '模拟 Cyrene 解读：NATIVE_CODE_OK';}}},registerIpc:(name,fn)=>handlers.set(name,fn)});
const timeout=setTimeout(()=>{console.error('native Code smoke timed out');app.exit(1)},30000);
app.whenReady().then(async()=>{
 const win=new BrowserWindow({title:'Cyrene Code 双线路 · Computer Use 验收',width:1100,height:850,show:${manual},webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});
 require('./ipc.cjs').registerCodeExecutorIpc({handle:(name,fn)=>ipcMain.handle(name,fn)},{getWindow:()=>win,getSession:id=>({id,mode:id==='chat-test'?'chat':'code',workspaceBinding:{workspaceRoot:__dirname}}),invoke:(action,data)=>handlers.get('native')(action,data)});
 await win.loadFile(path.join(__dirname,'index.html'));
 ${manual ? "clearTimeout(timeout); win.on('closed',()=>{abort.abort();for(const cleanup of cleanups.reverse())cleanup();app.quit();}); return;" : ""}
 const js=code=>win.webContents.executeJavaScript(code);
 const wait=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,100));}throw new Error('timeout: '+code)};
 const click=async text=>{const query='Array.from(document.querySelectorAll("button")).find(b=>b.textContent==='+JSON.stringify(text)+')';await wait('!!'+query);return js(query+'.click()')};
 await wait('!!document.querySelector("#native-send")');await js('document.querySelector("#native-send").click()');
 assert.equal(await js('globalThis.nativeSends'),1);
 assert.equal((await js('window.codeExecutor.invoke("chat-test","connect")')).ok,false);
 await js('document.querySelector(".cy-code-executor__route").click()');await click('Codex');
 await wait('!!document.querySelector("textarea")');await click('连接 / 刷新目录');
 await wait('!document.querySelector("textarea").disabled && !document.querySelector("textarea").closest("fieldset").disabled');
 await js('const field=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"  原生界面原文  ");field.dispatchEvent(new Event("input",{bubbles:true}))');
 await click('发送给 Codex');await wait('document.body.textContent.includes("确认选项")');await click('A');await click('提交回答');
 await wait('document.body.textContent.includes("模拟 Cyrene 解读：NATIVE_CODE_OK") && document.body.textContent.includes("会话已释放")');
 assert.equal(await js('document.querySelector(".cy-code-executor__route").disabled'),false);
 assert.equal(await js('document.body.textContent.includes("已完成")'),true);
 assert.equal(killed,1);assert.equal(summaryCalls,1);assert.equal(wire.filter(m=>m.method==='turn/start').length,1);
 await js('document.querySelector(".cy-code-executor__route").click()');await click('原生');
 await wait('!!document.querySelector("#native-send")');await js('document.querySelector("#native-send").click()');assert.equal(await js('globalThis.nativeSends'),2);
 fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({passed:true,nativeElectron:true,realCodex:false,realHostModel:false,nativeSends:2,chatDenied:true,questionAnswered:true,serverReleased:true,summaryCalls},null,2));
 abort.abort();for(const cleanup of cleanups.reverse())await cleanup();clearTimeout(timeout);console.log('Native Code integration passed: '+__dirname);app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
if (manual) await writeFile(path.join(root, "local-plugins/.test-runtime/native-code-cua-latest.json"), JSON.stringify({ run }));
const child = spawn(path.join(root, "node_modules/electron/dist/electron.exe"), [path.join(run, "host.cjs")], { env, windowsHide: true, detached: manual, stdio: manual ? "ignore" : "inherit" });
if (manual) { child.unref(); console.log(JSON.stringify({ run, pid: child.pid })); }
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
