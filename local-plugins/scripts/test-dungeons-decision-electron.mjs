// ZIP + actual host IPC + sandboxed official panel bridge, isolated from real app data.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), project = path.dirname(root);
const run = path.join(root, ".test-runtime", `dungeons-decision-electron-${Date.now()}`);
await mkdir(run, { recursive: true });
await writeFile(path.join(run, "entry.ts"), `export {PluginManager} from ${JSON.stringify(path.join(project, "src/plugins/manager"))};export {createPluginIpcRouter} from ${JSON.stringify(path.join(project, "src/plugins/ipc-router"))};export {registerPluginPanelScheme,resolvePluginPanelRequest} from ${JSON.stringify(path.join(project, "src/main/plugin-panel-protocol"))};`);
await build({ entryPoints: [path.join(run, "entry.ts")], outfile: path.join(run, "host-api.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"], logLevel: "silent" });
await writeFile(path.join(run, "preload.cjs"), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testHost',{invoke:request=>ipcRenderer.invoke('decision-test',request)});`);
await writeFile(path.join(run, "host.html"), `<!doctype html><meta charset="utf-8"><iframe id="panel" sandbox="allow-scripts allow-same-origin" src="cyrene-plugin://dungeons-decision/settings.html" style="width:100%;height:95vh;border:0"></iframe><script>const frame=document.getElementById('panel');frame.addEventListener('load',()=>frame.contentWindow.postMessage({protocol:'cyrene-panel/1',kind:'init',theme:{}},'cyrene-plugin://dungeons-decision'));window.addEventListener('message',async event=>{if(event.source!==frame.contentWindow||event.origin!=='cyrene-plugin://dungeons-decision')return;const m=event.data;if(m?.protocol!=='cyrene-panel/1'||m.kind!=='invoke')return;const result=await window.testHost.invoke({channel:m.channel,args:m.args});event.source.postMessage({protocol:'cyrene-panel/1',kind:'invoke-result',seq:m.seq,...result},event.origin)});</script>`);
await writeFile(path.join(run, "host.cjs"), `
const{app,BrowserWindow,ipcMain,protocol}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{PluginManager,createPluginIpcRouter,registerPluginPanelScheme,resolvePluginPanelRequest}=require('./host-api.cjs');
app.disableHardwareAcceleration();for(const name of ['userData','sessionData','logs']){fs.mkdirSync(path.join(__dirname,name),{recursive:true});app.setPath(name,path.join(__dirname,name))}registerPluginPanelScheme();
let manager,win,enabled={};const checks=[],errors=[],router=createPluginIpcRouter(),called=[];
const forbidden=()=>{throw Error('Unrelated host service called')};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const timeout=setTimeout(()=>{fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:false,checks,errors,error:'deadline'}));app.exit(1)},30000);
async function wait(test){for(let i=0;i<100;i++){if(await test())return;await sleep(50)}throw Error('Condition not reached')}
const invoke=(channel,...args)=>manager.invokePluginIpc('dungeons-decision',channel,args);
app.whenReady().then(async()=>{
manager=new PluginManager({scanRoots:[{path:path.join(__dirname,'plugins'),source:'user'}],storageRoot:path.join(__dirname,'plugin-data'),loadEnabledMap:()=>enabled,saveEnabledMap:map=>{enabled=map},runtime:{toolRegistry:{register:forbidden,unregister:forbidden},channelManager:{has:()=>false,register:forbidden,unregister:forbidden,startOne:forbidden},promptRegistry:{register:forbidden,unregister:forbidden,registerStable:forbidden,unregisterStable:forbidden},registerIpc:(name,fn)=>{called.push(name);router.register(name,fn)},unregisterIpc:name=>router.unregister(name),invokeIpc:(name,args)=>router.invokeRegistered(name,args)}});
await manager.start();const installed=await manager.installZip(${JSON.stringify(path.join(root, "artifacts/dungeons-decision.zip"))});assert.equal(installed.ok,true,installed.error);assert.equal(manager.isRunning('dungeons-decision'),false);checks.push('Actual host imports decision ZIP; defaults disabled');
assert.equal((await manager.setEnabled('dungeons-decision',true)).ok,true);assert.equal(invoke('decision-status').gameInputSent,false);checks.push('Enable creates only an in-memory simulation session');
const scenarios=invoke('decision-examples');assert.equal(scenarios.length,12);
for(const scenario of scenarios){invoke('decision-reset');const result=invoke('decision-preview',invoke('decision-example',scenario.id));assert.equal(result.action,scenario.expected);assert.equal(result.gameInputSent,false);assert.equal(result.gameOutcomeVerified,false)}checks.push('All 12 packaged scenarios match expected decisions through actual host IPC');
invoke('decision-reset');protocol.handle('cyrene-plugin',async request=>{const response=await resolvePluginPanelRequest(request.url,id=>manager.getSettingsPanelDir(id),${JSON.stringify(path.join(project, "src/main/plugin-panel"))});return response.status===404?new Response(null,{status:404}):new Response(response.body,{headers:{'Content-Type':response.contentType}})});
ipcMain.handle('decision-test',(event,request)=>{if(event.sender!==win.webContents)throw Error('Wrong sender');return router.dispatch({pluginId:'dungeons-decision',channel:request.channel,args:request.args,caller:'panel'})});
win=new BrowserWindow({show:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.on('preload-error',(_event,_file,error)=>errors.push(String(error)));win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});await win.loadFile(path.join(__dirname,'host.html'));const frame=()=>win.webContents.mainFrame.frames.find(f=>f.url.includes('dungeons-decision/settings.html'));
await wait(async()=>frame()&&await frame().executeJavaScript("document.querySelector('#history').textContent.length>0"));assert.equal(await frame().executeJavaScript("document.querySelector('#scenario').options.length"),12);checks.push('Actual sandboxed panel initializes through official bridge');
await frame().executeJavaScript("document.querySelector('#scenario').value='heal';document.querySelector('#run-example').click()");await wait(async()=>await frame().executeJavaScript("!document.querySelector('#complete').disabled"));assert.equal(invoke('decision-status').pending.action,'heal');checks.push('Native panel generates a heal proposal, without sending input');
await frame().executeJavaScript("document.querySelector('#complete').click()");await wait(async()=>await frame().executeJavaScript("document.querySelector('#complete').disabled"));assert.equal(invoke('decision-status').reports.at(-1).status,'simulated-complete');assert.equal(invoke('decision-status').reports.at(-1).gameOutcomeVerified,false);checks.push('Simulation feedback cannot claim real game success');
await frame().executeJavaScript("document.querySelector('#stop').click()");await wait(()=>invoke('decision-status').stopped);checks.push('Panel stop latches simulation stopped');
const owned=called.filter(name=>name.startsWith('plugin:'));assert.equal(owned.length,7);assert.ok(owned.every(name=>name.startsWith('plugin:dungeons-decision:decision-')));assert.equal(errors.length,0,JSON.stringify(errors));
await manager.setEnabled('dungeons-decision',false);assert.equal((await router.dispatch({pluginId:'dungeons-decision',channel:'decision-status',args:[],caller:'panel'})).ok,false);checks.push('Disable removes owned IPC; no input, tool, prompt or conversation services used');
await manager.stop();win.destroy();clearTimeout(timeout);fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:true,nativeElectron:true,checks,errors,simulationOnly:true,gameInputSent:false,gameLaunched:false,realGameCoopVerified:false,conversationServicesUsed:false},null,2));app.exit(0);
}).catch(async error=>{console.error(error);fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify({ok:false,checks,errors,error:String(error)},null,2));try{await manager?.stop()}catch{}app.exit(1)});
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
