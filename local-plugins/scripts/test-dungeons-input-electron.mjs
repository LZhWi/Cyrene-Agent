// Actual ZIP installer and panel bridge, using only isolated app/plugin data.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.dirname(root);
const queuedPulse = process.argv.includes("--queued-pulse");
const realSettings = process.argv.includes("--real-settings");
const fixtureIndex = process.argv.indexOf("--fixture-preview");
const fixturePreview = fixtureIndex >= 0;
const run = path.join(root, ".test-runtime", `dungeons-input-electron-${Date.now()}`);
await mkdir(run, { recursive: true });
if (fixturePreview) await writeFile(path.join(run, "preview-fixture.json"), await readFile(process.argv[fixtureIndex + 1]));
await writeFile(path.join(run, "entry.ts"), `export {PluginManager} from ${JSON.stringify(path.join(project, "src/plugins/manager"))};export {createPluginIpcRouter} from ${JSON.stringify(path.join(project, "src/plugins/ipc-router"))};export {registerPluginPanelScheme,resolvePluginPanelRequest} from ${JSON.stringify(path.join(project, "src/main/plugin-panel-protocol"))};`);
await build({ entryPoints: [path.join(run, "entry.ts")], outfile: path.join(run, "host-api.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"], logLevel: "silent" });
await writeFile(path.join(run, "preload.cjs"), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testHost',{invoke:request=>ipcRenderer.invoke('dungeons-test',request)});`);
await writeFile(path.join(run, "host.html"), `<!doctype html><meta charset="utf-8"><iframe id="panel" sandbox="allow-scripts allow-same-origin" src="cyrene-plugin://dungeons-input/settings.html" style="width:100%;height:95vh;border:0"></iframe><script>const frame=document.getElementById('panel');frame.addEventListener('load',()=>frame.contentWindow.postMessage({protocol:'cyrene-panel/1',kind:'init',theme:{}},'cyrene-plugin://dungeons-input'));window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.origin!=='cyrene-plugin://dungeons-input')return;const message=event.data;if(message?.protocol!=='cyrene-panel/1'||message.kind!=='invoke')return;const result=await window.testHost.invoke({channel:message.channel,args:message.args});event.source.postMessage({protocol:'cyrene-panel/1',kind:'invoke-result',seq:message.seq,...result},event.origin)});</script>`);
if (realSettings) {
  await writeFile(path.join(run, "settings-entry.ts"), `import {mountPluginPanels} from ${JSON.stringify(path.join(project, "src/renderer/settings/plugin-panels"))};void mountPluginPanels();`);
  await build({ entryPoints: [path.join(run, "settings-entry.ts")], outfile: path.join(run, "settings-host.js"), bundle: true, platform: "browser", target: "chrome140", logLevel: "silent" });
  await writeFile(path.join(run, "preload.cjs"), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('plugins',{list:()=>ipcRenderer.invoke('dungeons-overview')});contextBridge.exposeInMainWorld('pluginPanel',{invoke:(pluginId,channel,args)=>ipcRenderer.invoke('dungeons-test',{pluginId,channel,args})});`);
  await writeFile(path.join(run, "host.html"), `<!doctype html><meta charset="utf-8"><div class="plugin-panels" id="plugin-panels-plugins"></div><div class="plugin-panels" id="plugin-panels-channels"></div><script src="settings-host.js"></script>`);
}
await writeFile(path.join(run, "host.cjs"), `
const{app,BrowserWindow,ipcMain,protocol}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{PluginManager,createPluginIpcRouter,registerPluginPanelScheme,resolvePluginPanelRequest}=require('./host-api.cjs');
app.disableHardwareAcceleration();for(const name of ['userData','sessionData','logs']){fs.mkdirSync(path.join(__dirname,name),{recursive:true});app.setPath(name,path.join(__dirname,name))}registerPluginPanelScheme();
let manager,win,enabled={},previewFixture;const checks=[],errors=[],panelInvocations=[],router=createPluginIpcRouter();
const forbidden=()=>{throw Error('Unrelated host service called')};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const timeout=setTimeout(()=>{fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:false,checks,errors,error:'deadline'}));app.exit(1)},30000);
async function wait(test){for(let i=0;i<100;i++){if(await test())return;await sleep(100)}throw Error('Condition not reached')}
const invoke=(channel,...args)=>manager.invokePluginIpc('dungeons-input',channel,args);
app.whenReady().then(async()=>{
manager=new PluginManager({scanRoots:[{path:path.join(__dirname,'plugins'),source:'user'}],storageRoot:path.join(__dirname,'plugin-data'),loadEnabledMap:()=>enabled,saveEnabledMap:map=>{enabled=map},runtime:{toolRegistry:{register:forbidden,unregister:forbidden},channelManager:{has:()=>false,register:forbidden,unregister:forbidden,startOne:forbidden},promptRegistry:{register:forbidden,unregister:forbidden,registerStable:forbidden,unregisterStable:forbidden},registerIpc:(name,fn)=>router.register(name,fn),unregisterIpc:name=>router.unregister(name),invokeIpc:(name,args)=>router.invokeRegistered(name,args)}});
await manager.start();const installed=await manager.installZip(${JSON.stringify(path.join(root, "artifacts/dungeons-input.zip"))});assert.equal(installed.ok,true,installed.error);assert.equal(manager.isRunning('dungeons-input'),false);checks.push('Actual host imports ZIP; defaults disabled');
assert.equal((await manager.setEnabled('dungeons-input',true)).ok,true);assert.equal(invoke('input-status').running,false);checks.push('Enable registers only input IPC; creates no devices');
const probe=await invoke('input-probe');assert.equal(typeof probe.available,'boolean');checks.push('Packaged x64 native DLL and .NET worker return actual bus probe');
protocol.handle('cyrene-plugin',async request=>{
if(${realSettings}&&request.url.endsWith('/test-delayed.png')){await sleep(500);return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64'),{headers:{'Content-Type':'image/png'}})}
const response=await resolvePluginPanelRequest(request.url,id=>manager.getSettingsPanelDir(id),${JSON.stringify(path.join(project, "src/main/plugin-panel"))});
if(response.status===404)return new Response(null,{status:404});let body=response.body;
// Force child scripts to run before the parent iframe load/registration.
// Only the isolated test response gets a delayed resource; ZIP stays unchanged.
if(${realSettings}&&request.url.endsWith('/settings.html'))body=Buffer.from(body.toString().replace('</body>','<img src="test-delayed.png" hidden></body>'));
return new Response(body,{headers:{'Content-Type':response.contentType}})});
ipcMain.handle('dungeons-overview',event=>{if(event.sender!==win.webContents)throw Error('Wrong sender');return manager.overview()});
ipcMain.handle('dungeons-test',(event,request)=>{if(event.sender!==win.webContents)throw Error('Wrong sender');panelInvocations.push(request.channel);if(previewFixture&&request.channel==='input-status')return{ok:true,data:{running:false,state:{ready:false,pads:[]},results:[],notices:[],follow:{phase:'complete',reason:'Fixture preview only; no game capture',frame:previewFixture}}};return router.dispatch({pluginId:'dungeons-input',channel:request.channel,args:request.args,caller:'panel'})});
win=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.on('preload-error',(_event,_file,error)=>errors.push(String(error)));win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});await win.loadFile(path.join(__dirname,'host.html'));const frame=()=>win.webContents.mainFrame.frames.find(frame=>frame.url.includes('dungeons-input/settings.html'));
await wait(async()=>frame()&&await frame().executeJavaScript("document.querySelector('#summary').textContent==='测试手柄未连接'"));checks.push('Actual sandboxed native panel loads and polls via official bridge');
if(${realSettings}){assert.ok(panelInvocations.includes('input-status'));checks.push('Actual settings renderer with forced pre-load race receives the first status after initialization')}
assert.deepEqual(await frame().executeJavaScript("({pad:document.querySelector('#pad').value,confirmed:document.querySelector('#confirm-p1').checked,controls:document.querySelector('#control').options.length})"),{pad:'2',confirmed:false,controls:19});checks.push('Panel defaults P2, P1 unconfirmed, 19 raw controls');
assert.deepEqual(await frame().executeJavaScript("Array.from(document.querySelectorAll('[data-menu-control]')).map(b=>({control:b.dataset.menuControl,disabled:b.disabled}))"),['A','B','DpadUp','DpadDown','DpadLeft','DpadRight'].map(control=>({control,disabled:true})));checks.push('Six gamepad menu shortcuts stay disabled until owned worker readiness');
assert.deepEqual(await frame().executeJavaScript("({confirmed:document.querySelector('#confirm-camp').checked,observe:document.querySelector('#observe').disabled,follow:document.querySelector('#follow').disabled,stop:document.querySelector('#follow-cancel').disabled})"),{confirmed:false,observe:true,follow:true,stop:true});checks.push('Camp follow defaults unconfirmed and cannot run without owned input devices');
await frame().executeJavaScript("document.querySelector('#probe').click()");await wait(async()=>await frame().executeJavaScript("document.querySelector('#notice').textContent.length>0"));checks.push('Native panel invokes actual driver probe');
if(!probe.available){await invoke('input-start');await wait(()=>!invoke('input-status').running);assert.equal(invoke('input-status').state.ready,false);assert.ok(invoke('input-status').notices.length>0);checks.push('Missing driver fails explicitly; creates no usable session or retry')}
if(${queuedPulse}){
assert.equal(probe.available,true);await invoke('input-start');await wait(()=>invoke('input-status').state.ready);
const queued=invoke('input-pulse',{pad:2,control:'LeftThumb',durationMs:200,delayMs:10000});invoke('input-cancel');
await wait(()=>invoke('input-status').results.find(r=>r.id===queued.id)?.status==='cancelled');
assert.equal(invoke('input-status').results.find(r=>r.id===queued.id).inputWasSent,false);checks.push('Real native worker acknowledges and cancels queued LS without sending it');
await wait(async()=>await frame().executeJavaScript("document.querySelector('#result').textContent.includes('已停止')"));checks.push('Native panel displays the actual terminal worker result');
await invoke('input-stop');await wait(()=>!invoke('input-status').running);checks.push('Owned diagnostic session stops before plugin disable');
}
if(${fixturePreview}){
previewFixture=JSON.parse(fs.readFileSync(path.join(__dirname,'preview-fixture.json'),'utf8'));
await wait(async()=>await frame().executeJavaScript("document.querySelector('#preview').width===1280 && document.querySelector('#preview').style.display==='block'"));
assert.deepEqual(await frame().executeJavaScript("({width:document.querySelector('#preview').width,height:document.querySelector('#preview').height})"),{width:1280,height:800});
const png=await frame().executeJavaScript("document.querySelector('#preview').toDataURL('image/png')");assert.ok(png.length>100000);fs.writeFileSync(path.join(__dirname,'rendered-preview.png'),Buffer.from(png.split(',')[1],'base64'));
checks.push('Actual sandboxed canvas renders supplied native vision fixture and marker overlays through official IPC; no desktop capture or game input');
}
assert.equal(errors.length,0,JSON.stringify(errors));await manager.setEnabled('dungeons-input',false);assert.equal((await router.dispatch({pluginId:'dungeons-input',channel:'input-status',args:[],caller:'panel'})).ok,false);checks.push('Disable removes IPC and disposes workers');
await manager.stop();win.destroy();clearTimeout(timeout);fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:true,nativeElectron:true,checks,errors,probe,realSettingsRendererUsed:${realSettings},loadingRaceForced:${realSettings},fixturePreviewUsed:${fixturePreview},actualDevicesCreated:${queuedPulse},queuedPulseCancelledBeforeInput:${queuedPulse},gameLaunched:false,realGameCoopVerified:false,conversationServicesUsed:false},null,2));app.exit(0);
}).catch(async error=>{console.error(error);fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:false,checks,errors,panelInvocations,error:String(error)},null,2));try{await manager?.stop()}catch{}app.exit(1)});
`);
const env = { ...process.env, APPDATA: path.join(run, "app-data"), LOCALAPPDATA: path.join(run, "local-app-data"), TEMP: path.join(run, "temp"), TMP: path.join(run, "temp") };
delete env.ELECTRON_RUN_AS_NODE;
for (const name of ["APPDATA", "LOCALAPPDATA", "TEMP"]) await mkdir(env[name], { recursive: true });
const child = spawn(path.join(project, "node_modules/electron/dist/electron.exe"), [path.join(run, "host.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
await writeFile(path.join(run, "electron.log"), logs);
try { console.log(await readFile(path.join(run, "result.json"), "utf8")); } catch { console.error(logs.slice(-3000)); }
console.log(`Report: ${run}`); process.exitCode = code ?? 1;
