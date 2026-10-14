// No app installation, credentials, models or server connection.
import { unzipSync } from "fflate";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zipPath = path.join(root, "artifacts", "minecraft-body.zip");
const entries = unzipSync(new Uint8Array(await readFile(zipPath)));
const temporary = await mkdtemp(path.join(os.tmpdir(), "cyrene-minecraft-body-package-"));
const pluginRoot = path.join(temporary, "minecraft-body");
try {
  for (const [name, bytes] of Object.entries(entries)) {
    const parts = name.split("/");
    if (parts[0] !== "minecraft-body" || parts.some((part) => !part || part === ".." || part === ".") || /[\\:]/.test(name)) throw new Error("ZIP 路径无效");
    const file = path.join(temporary, ...parts);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const guard = path.join(temporary, "guard.cjs");
  await writeFile(guard, `const Module=require('node:module'),path=require('node:path');const original=Module._resolveFilename;const root=${JSON.stringify(temporary)};Module._resolveFilename=function(...args){const file=original.apply(this,args);if(path.isAbsolute(file)&&file!==root&&!file.startsWith(root+path.sep))throw Error('Host dependency fallback: '+file);return file;};`);
  const smoke = path.join(temporary, "smoke.cjs");
  await writeFile(smoke, `
const assert=require('node:assert/strict'),path=require('node:path'),{fork}=require('node:child_process');
const root=${JSON.stringify(pluginRoot)},guard=${JSON.stringify(guard)};
const manifest=require(path.join(root,'manifest.json'));assert.equal(manifest.defaultEnabled,false);
const d=require(path.join(root,'runtime/node_modules/minecraft-data'));
const mf=require(path.join(root,'runtime/node_modules/mineflayer'));
for(const version of mf.testedVersions){assert.ok(d(version).blocksArray.length);assert.ok(d(version).protocol)}
require(path.join(root,'runtime/node_modules/mineflayer-pathfinder'));
require(path.join(root,'runtime/node_modules/prismarine-auth'));
const channels=new Map,cleanup=[];
const forbidden=()=>{throw Error('Conversation integration is forbidden')};
const ctx={signal:new AbortController().signal,storage:{rootDir:()=>path.join(root,'private-data')},onDispose:fn=>cleanup.push(fn),registerIpc:(name,fn)=>channels.set(name,fn),registerTool:forbidden,registerPromptProvider:forbidden,registerChannelAdapter:forbidden,events:{on:forbidden,emit:forbidden},deps:new Proxy({},{get:forbidden})};
const plugin=require(path.join(root,'index.cjs'));(plugin.default||plugin).register(ctx);
assert.equal(channels.get('body-status')().running,false);assert.equal(channels.size,5);
const child=fork(path.join(root,'runtime/sidecar.cjs'),[],{cwd:path.join(root,'runtime'),execArgv:['--require',guard],env:{...process.env,NODE_PATH:''},stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
let stderr='';child.stderr.on('data',chunk=>stderr+=String(chunk));
const timer=setTimeout(()=>{child.kill();console.error('Sidecar stop deadline exceeded');process.exitCode=1},5000);
child.once('spawn',()=>child.send({type:'stop'}));
child.once('exit',async(code)=>{clearTimeout(timer);try{assert.equal(code,0,stderr);for(const fn of cleanup)await fn();console.log(JSON.stringify({isolatedPackage:true,javaVersions:mf.testedVersions.length,sidecarStopped:true,conversationServicesUsed:false}))}catch(error){console.error(error);process.exitCode=1}});
`);
  console.log(execFileSync(process.execPath, ["--require", guard, smoke], {
    cwd: temporary, env: { ...process.env, NODE_PATH: "" }, encoding: "utf8", timeout: 15000,
  }).trim());
} finally {
  // Fresh mkdtemp directory belonging solely to this script, checked before removal.
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("cyrene-minecraft-body-package-")) throw new Error("临时目录边界校验失败");
  await rm(resolved, { recursive: true, force: true });
}
