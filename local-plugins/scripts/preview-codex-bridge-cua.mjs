// Visible, isolated plugin host for human/Computer Use acceptance testing.
// Codex is real. Only the host LLM is replaced with a file-based manual response.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = path.join(root, ".test-runtime", `codex-bridge-cua-${Date.now()}`);
const workspace = path.join(run, "workspace");
const skill = path.join(workspace, ".agents", "skills", "cyrene-ui-check");
await mkdir(skill, { recursive: true });
await writeFile(path.join(skill, "SKILL.md"), "---\nname: cyrene-ui-check\ndescription: Text-only UI acceptance test; returns UI_SKILL_OK plus the answer.\n---\nStart your answer with UI_SKILL_OK, then answer the user's arithmetic question. Do not call tools or read or modify files.\n");
await writeFile(path.join(run, "host.cjs"), `
const {app,ipcMain,BrowserWindow}=require('electron');
const fs=require('node:fs'), path=require('node:path');
const run=__dirname, storageRoot=path.join(run,'storage'); fs.mkdirSync(storageRoot,{recursive:true});
app.setPath('userData',path.join(run,'userData'));app.setPath('sessionData',path.join(run,'sessionData'));app.setPath('logs',path.join(run,'logs'));
app.setAppUserModelId('cyrene.codex.bridge.cua');
const abort=new AbortController(),cleanups=[];
let sequence=0;
const ctx={id:'codex-bridge',signal:abort.signal,onDispose:fn=>cleanups.push(fn),
 storage:{rootDir:()=>storageRoot,get:key=>{const f=path.join(storageRoot,key+'.json');return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):undefined;},set:(key,value)=>fs.writeFileSync(path.join(storageRoot,key+'.json'),JSON.stringify(value,null,2))},
 deps:{llm:{generateText:async(messages,options)=>{
   const id=++sequence;fs.writeFileSync(path.join(run,'reply-request-'+id+'.json'),JSON.stringify({messages,simulatedHostLlm:true},null,2));
   const response=path.join(run,'reply-response-'+id+'.json'),end=Date.now()+300000;
   while(Date.now()<end){if(options.signal?.aborted)throw Error('测试已结束');if(fs.existsSync(response))return JSON.parse(fs.readFileSync(response,'utf8')).text;await new Promise(resolve=>setTimeout(resolve,300));}
   throw Error('等待手动模拟回复超时');
 }}},registerIpc:(channel,handler)=>ipcMain.handle('plugin:codex-bridge:'+channel,async(event,...args)=>{
   if(!BrowserWindow.getAllWindows().some(win=>win.webContents===event.sender))throw Error('Invalid test sender');
   const result=await handler(...args);if(args[0]!=='state')fs.appendFileSync(path.join(run,'actions.jsonl'),JSON.stringify({action:args[0],ok:result.ok,at:new Date().toISOString()})+'\\n');return result;
 })};
app.whenReady().then(async()=>{const plugin=require(${JSON.stringify(path.join(root, "artifacts", "codex-bridge", "index.cjs"))});plugin.register(ctx);await plugin.open();const win=BrowserWindow.getAllWindows()[0];win.setTitle('Cyrene Codex 插件 · Computer Use 验收');});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{abort.abort();for(const cleanup of cleanups.reverse())cleanup();});
`);
await writeFile(path.join(root, ".test-runtime", "codex-bridge-cua-latest.json"), JSON.stringify({ run, workspace }, null, 2));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(root,"..","node_modules","electron","dist","electron.exe"),[path.join(run,"host.cjs")],{env,detached:true,stdio:"ignore"});
child.unref();
console.log(JSON.stringify({ run, workspace, pid: child.pid }));
