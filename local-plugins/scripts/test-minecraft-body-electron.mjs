// Native Electron + actual host installer/manager/protocol, isolated from Chat.
import { build } from "esbuild";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.dirname(root);
const run = path.join(root, ".test-runtime", `minecraft-body-electron-${Date.now()}`);
await mkdir(run, { recursive: true });
await writeFile(path.join(run, "entry.ts"), `export { PluginManager } from ${JSON.stringify(path.join(project, "src/plugins/manager"))};
export { createPluginIpcRouter } from ${JSON.stringify(path.join(project, "src/plugins/ipc-router"))};
export { registerPluginPanelScheme, resolvePluginPanelRequest } from ${JSON.stringify(path.join(project, "src/main/plugin-panel-protocol"))};`);
await build({ entryPoints: [path.join(run, "entry.ts")], outfile: path.join(run, "host-api.cjs"), bundle: true,
  platform: "node", format: "cjs", target: "node24", external: ["electron"], logLevel: "silent" });
await writeFile(path.join(run, "preload.cjs"), `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testHost',{invoke:(request)=>ipcRenderer.invoke('mc-test-panel',request)});`);
await writeFile(path.join(run, "host.html"), `<!doctype html><meta charset="utf-8"><iframe id="panel" sandbox="allow-scripts allow-same-origin" src="cyrene-plugin://minecraft-body/settings.html" style="width:100%;height:95vh;border:0"></iframe><script>
const frame=document.getElementById('panel');window.addEventListener('message',async(event)=>{
 if(event.source!==frame.contentWindow||event.origin!=='cyrene-plugin://minecraft-body')return;
 const request=event.data;if(request?.protocol!=='cyrene-panel/1'||request.kind!=='invoke')return;
 const result=await window.testHost.invoke({channel:request.channel,args:request.args});
 event.source.postMessage({protocol:'cyrene-panel/1',kind:'invoke-result',seq:request.seq,...result},event.origin);
});</script>`);
const host = `
const {app,BrowserWindow,ipcMain,protocol}=require('electron');const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict'),net=require('node:net');
const {PluginManager,createPluginIpcRouter,registerPluginPanelScheme,resolvePluginPanelRequest}=require('./host-api.cjs');
const run=__dirname;app.disableHardwareAcceleration();for(const name of ['userData','sessionData','logs']){fs.mkdirSync(path.join(run,name),{recursive:true});app.setPath(name,path.join(run,name))}registerPluginPanelScheme();
const router=createPluginIpcRouter(),checks=[],errors=[];let enabled={},manager,win;
const forbidden=()=>{throw Error('Unrelated host service used')};
const timeout=setTimeout(()=>{fs.writeFileSync(path.join(run,'result.json'),JSON.stringify({ok:false,checks,errors,error:'native test deadline'}));app.exit(1)},25000);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(test){for(let i=0;i<100;i++){if(await test())return;await sleep(100)}throw Error('Condition not reached')}
const invoke=(channel,...args)=>manager.invokePluginIpc('minecraft-body',channel,args);
app.whenReady().then(async()=>{
 manager=new PluginManager({scanRoots:[{path:path.join(run,'plugins'),source:'user'}],storageRoot:path.join(run,'data'),loadEnabledMap:()=>enabled,saveEnabledMap:map=>{enabled=map},runtime:{
 toolRegistry:{register:forbidden,unregister:forbidden},channelManager:{has:()=>false,register:forbidden,unregister:forbidden,startOne:forbidden},promptRegistry:{register:forbidden,unregister:forbidden,registerStable:forbidden,unregisterStable:forbidden},
 registerIpc:(name,fn)=>router.register(name,fn),unregisterIpc:name=>router.unregister(name),invokeIpc:(name,args)=>router.invokeRegistered(name,args)}});
 await manager.start();const imported=await manager.installZip(${JSON.stringify(path.join(root, "artifacts/minecraft-body.zip"))});assert.equal(imported.ok,true,imported.error);assert.equal(manager.isRunning('minecraft-body'),false);checks.push('Actual host ZIP import; default disabled');
 assert.equal((await manager.setEnabled('minecraft-body',true)).ok,true);assert.equal(invoke('body-status').running,false);checks.push('Actual PluginContext enabled without auto-connect or Chat services');
 protocol.handle('cyrene-plugin',async request=>{const response=await resolvePluginPanelRequest(request.url,id=>manager.getSettingsPanelDir(id),${JSON.stringify(path.join(project, "src/main/plugin-panel"))});return response.status===404?new Response(null,{status:404}):new Response(response.body,{headers:{'Content-Type':response.contentType}})});
 win=new BrowserWindow({show:false,width:900,height:950,webPreferences:{preload:path.join(run,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 win.webContents.on('preload-error',(_event,_path,error)=>errors.push(String(error)));win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message)});
 ipcMain.handle('mc-test-panel',async(event,request)=>{if(event.sender!==win.webContents)throw Error('Wrong sender');return router.dispatch({pluginId:'minecraft-body',channel:request.channel,args:request.args,caller:'panel'})});
 await win.loadFile(path.join(run,'host.html'));
 const frame=()=>win.webContents.mainFrame.frames.find(frame=>frame.url.includes('cyrene-plugin://minecraft-body/'));
 await wait(async()=>frame()&&await frame().executeJavaScript("document.querySelector('#state').textContent.includes('connected')"));
 assert.equal(await frame().executeJavaScript("document.querySelector('#execute').disabled"),true);checks.push('Sandbox iframe + actual Panel Bridge status/disabled action');
 assert.equal(await frame().executeJavaScript("document.querySelector('#result').textContent"),'尚未执行动作。');
 const controls=await frame().executeJavaScript("(()=>{const a=document.querySelector('#action');a.value='goto';a.dispatchEvent(new Event('change'));const goto=getComputedStyle(document.querySelector('#coordinates')).display!=='none'&&document.querySelector('#material').disabled;a.value='door';a.dispatchEvent(new Event('change'));const door=getComputedStyle(document.querySelector('#coordinates')).display==='none'&&getComputedStyle(document.querySelector('#door-field')).display!=='none';a.value='plant';a.dispatchEvent(new Event('change'));const farm=!document.querySelector('#material').disabled&&!document.querySelector('#count').disabled&&getComputedStyle(document.querySelector('#door-field')).display==='none';return {goto,door,farm,actions:a.options.length}})()");
 assert.deepEqual(controls,{goto:true,door:true,farm:true,actions:30});checks.push('All 30 daily actions and conditional coordinates/door/crop controls present in native panel');
 await frame().executeJavaScript("document.querySelector('#owner').value='Owner';document.querySelector('#port').value='0';document.querySelector('#connect').click()");
 await wait(async()=>await frame().executeJavaScript("document.querySelector('#notice').textContent.includes('端口')"));checks.push('Native panel validates connection input');
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 await invoke('body-start',{host:'127.0.0.1',port,username:'Cyrene',owner:'Owner',auth:'offline',version:'1.21.4'});
 await wait(()=>!invoke('body-status').running);checks.push('Native Electron forks real packaged Mineflayer; refused local connection exits');
 await invoke('body-start',{host:'127.0.0.1',port,username:'Cyrene',owner:'Owner',auth:'offline',version:'1.21.4'});
 await manager.setEnabled('minecraft-body',false);assert.equal(manager.isRunning('minecraft-body'),false);assert.equal((await router.dispatch({pluginId:'minecraft-body',channel:'body-status',args:[],caller:'panel'})).ok,false);checks.push('Disable disposes child and unregisters IPC');
 assert.equal(errors.length,0,JSON.stringify(errors));await manager.setEnabled('minecraft-body',true);assert.equal(invoke('body-status').running,false);await manager.stop();win.destroy();
 fs.writeFileSync(path.join(run,'result.json'),JSON.stringify({ok:true,nativeElectron:true,actualHostInstaller:true,actualHostContext:true,checks,errors,realMinecraftServer:false,conversationServicesUsed:false},null,2));clearTimeout(timeout);console.log('Native MC plugin passed: '+run);app.exit(0);
}).catch(async error=>{console.error(error);fs.writeFileSync(path.join(run,'result.json'),JSON.stringify({ok:false,checks,errors,error:String(error)},null,2));try{await manager?.stop()}catch{}app.exit(1)});
`;
await writeFile(path.join(run, "host.cjs"), host);
const env = { ...process.env, APPDATA: path.join(run, "app-data"), LOCALAPPDATA: path.join(run, "local-app-data"), TEMP: path.join(run, "temp"), TMP: path.join(run, "temp") };
delete env.ELECTRON_RUN_AS_NODE;
for (const key of ["APPDATA", "LOCALAPPDATA", "TEMP"]) await mkdir(env[key], { recursive: true });
const child = spawn(path.join(project, "node_modules/electron/dist/electron.exe"), [path.join(run, "host.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
await writeFile(path.join(run, "electron.log"), logs);
try { console.log(await readFile(path.join(run, "result.json"), "utf8")); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.error(`Electron exited before producing a report (code ${code}):\n${logs.slice(-3000)}`);
}
console.log(`Report: ${run}`);
process.exitCode = code ?? 1;
