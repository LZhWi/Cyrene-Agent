import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = path.join(root, ".test-runtime", `codex-bridge-electron-${Date.now()}`);
await mkdir(run, { recursive: true });
const script = path.join(run, "host.cjs");
const source = `
const electronApi = require('electron');
const { app, BrowserWindow, ipcMain } = electronApi;
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const run = __dirname;
app.disableHardwareAcceleration();
app.setPath('userData', path.join(run, 'userData'));
app.setPath('sessionData', path.join(run, 'sessionData'));
app.setPath('logs', path.join(run, 'logs'));
app.on('browser-window-created', (_event, window) => window.hide());
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'electron') return { ...electronApi, BrowserWindow: new Proxy(BrowserWindow, { construct(target, [options]) {
    return new target({ ...options, show:false, webPreferences:{...options.webPreferences,offscreen:true} });
  } }) };
  return originalLoad.call(this,request,...args);
};
const abort = new AbortController(), cleanups = [], wire = [], errors = [];
let llmCalls = 0, step = 0;
const screenshotErrors = [];
require('node:child_process').spawn = () => {
  const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const emit = msg => child.stdout.write(JSON.stringify(msg)+'\\n');
  const event = (method, params) => emit({method, params});
  child.stdin = new Writable({write(chunk, _enc, cb) {
    for (const line of chunk.toString().trim().split('\\n')) {
      const m = JSON.parse(line); wire.push(m);
      if (!m.method) {
        if (m.id === 'question') {
          assert.deepEqual(m.result, {answers:{choice:{answers:['A']}}});
          emit({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'test-thread',turnId:'test-turn',command:'echo isolated-test',cwd:run,availableDecisions:['accept','decline','cancel']}});
        } else if (m.id === 'approval') {
          assert.equal(m.result.decision, 'decline');
          event('turn/completed',{threadId:'test-thread',turn:{id:'test-turn',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'测试回执：审批已拒绝，没有执行命令。'}]}});
        }
        continue;
      }
      let result = {};
      if (m.method === 'account/read') result = {account:{type:'chatgpt',planType:'mock-plan'}};
      if (m.method === 'model/list') result = {data:[{model:'test-model',displayName:'隔离测试模型',isDefault:true,defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};
      if (m.method === 'skills/list') result = {data:[{cwd:run,skills:[{name:'test-skill',path:path.join(run,'SKILL.md'),description:'测试技能',enabled:true}]}]};
      if (m.method === 'thread/start') result = {thread:{id:'test-thread'}};
      if (m.method === 'turn/start') {
        assert.equal(m.params.input[0].text, '  原文测试\\n保持空格  ');
        assert.equal(m.params.input[1].type, 'skill'); assert.equal(llmCalls,0);
        result={turn:{id:'test-turn'}};
        setTimeout(()=> { event('turn/started',{threadId:'test-thread',turn:{id:'test-turn',status:'inProgress'}}); emit({id:'question',method:'item/tool/requestUserInput',params:{threadId:'test-thread',turnId:'test-turn',questions:[{id:'choice',question:'请选择测试选项',options:[{label:'A',description:'测试 A'}]}]}}); },100);
      }
      if(m.id!==undefined) emit({id:m.id,result});
    }
    cb();
  }});
  child.kill = () => {setImmediate(()=>child.emit('exit',0)); return true;};
  return child;
};
const plugin = require(${JSON.stringify(path.join(root, "artifacts", "codex-bridge", "index.cjs"))});
const data = new Map();
const ctx = {id:'codex-bridge',signal:abort.signal,onDispose:fn=>cleanups.push(fn),
 storage:{rootDir:()=>run,get:key=>data.get(key),set:(key,value)=>data.set(key,structuredClone(value))},
 deps:{llm:{generateText:async()=>{llmCalls++;return 'Cyrene 测试解读：任务已结束，命令未获批准。';}}},
 registerIpc:(name,handler)=>ipcMain.handle('plugin:codex-bridge:'+name,(_event,...args)=>handler(...args))};
const timer=setTimeout(()=>{console.error('UI smoke timed out at step '+step);app.exit(1);},30000);
app.on('web-contents-created',(_event,contents)=>{contents.on('preload-error',(_e,_p,err)=>errors.push(err.message));contents.on('console-message',event=>console.log('renderer:',event.message));});
async function waitFor(win, js) { for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(js))return;await new Promise(r=>setTimeout(r,100));}throw new Error('UI condition timed out: '+js); }
app.whenReady().then(async()=>{
  plugin.register(ctx); await plugin.open(); const win=BrowserWindow.getAllWindows()[0]; win.hide();
  const js = code=>win.webContents.executeJavaScript(code);
  await waitFor(win, "document.querySelector('#cwd') && !document.querySelector('#connect').disabled"); step=1;
  await js("document.querySelector('#cwd').value="+JSON.stringify(run)+";document.querySelector('#connect').click()");
  await waitFor(win,"!document.querySelector('#submit').disabled"); step=2;
  await js("document.querySelector('#skill').selectedIndex=1;document.querySelector('#message').value="+JSON.stringify('  原文测试\\n保持空格  ')+";document.querySelector('#submit').click()");
  await waitFor(win,"document.querySelector('.prompt input') !== null"); step=3;
  await js("document.querySelector('.prompt input').value='A'");
  await new Promise(r=>setTimeout(r,1500));
  assert.equal(await js("document.querySelector('.prompt input').value"),'A');
  try { fs.writeFileSync(path.join(run,'question.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()); } catch(error) { screenshotErrors.push(String(error)); }
  await js("Array.from(document.querySelectorAll('.prompt button')).find(b=>b.textContent==='提交回答').click()");
  await waitFor(win,"Array.from(document.querySelectorAll('.prompt button')).some(b=>b.textContent==='拒绝')"); step=4;
  await js("Array.from(document.querySelectorAll('.prompt button')).find(b=>b.textContent==='拒绝').click()");
  await waitFor(win,"document.body.textContent.includes('Cyrene 测试解读：')"); step=5;
  assert.equal(llmCalls,1); assert.equal(errors.length,0);
  try { fs.writeFileSync(path.join(run,'completed.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG()); } catch(error) { screenshotErrors.push(String(error)); }
  fs.writeFileSync(path.join(run,'result.json'),JSON.stringify({ok:true,llmCalls,wireMethods:wire.map(m=>m.method).filter(Boolean),preloadErrors:errors,screenshotErrors,nativeElectron:true,realCodex:false},null,2));
  abort.abort();for(const cleanup of cleanups.reverse())await cleanup();clearTimeout(timer);
  console.log('Native Electron smoke passed: '+run);app.exit(0);
}).catch(error=>{console.error('step',step,error);app.exit(1);});
`;
await writeFile(script, source);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const electron = path.join(root, "..", "node_modules", "electron", "dist", "electron.exe");
const child = spawn(electron, [script], { env, windowsHide: true, stdio: "inherit" });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
