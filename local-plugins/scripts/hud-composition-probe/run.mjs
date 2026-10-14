import { spawn } from "node:child_process";
import { mkdir, copyFile, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const source = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(source, "../.."), project = path.dirname(root);
const run = path.join(root, ".test-runtime", `hud-composition-${Date.now()}`);
await mkdir(run, { recursive: true });
const framework = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319", metadata = "C:\\Windows\\System32\\WinMetadata";
const refs = ["System.Runtime", "System.Runtime.InteropServices.WindowsRuntime", "System.Runtime.WindowsRuntime", "System.Numerics", "System.Numerics.Vectors", "System.Drawing", "System.Windows.Forms"].map(name => "/r:" + path.join(framework, name + ".dll"));
refs.push(...(await readdir(metadata)).filter(name => name.endsWith(".winmd")).map(name => "/r:" + path.join(metadata, name)));
async function execute(file, args, env = process.env) {
  const child = spawn(file, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  return { code, output };
}
const compile = await execute(path.join(framework, "csc.exe"), ["/nologo", "/target:exe", "/platform:x64", "/out:" + path.join(run, "GlassProbe.exe"), ...refs, path.join(source, "GlassProbe.cs")]);
if (compile.code) throw Error(compile.output);
await copyFile(path.join(source, "host.cjs"), path.join(run, "host.cjs"));
for (const file of ["hud.html", "hud.js", "style.css", "avatar.svg"]) await copyFile(path.join(root, "plugins/cyrene-hud", file), path.join(run, file));
await writeFile(path.join(run, "preload.cjs"), `require('electron').contextBridge.exposeInMainWorld('cyreneHud',{state:async()=>({config:{metric:'clock',width:600,height:200,radius:60},effectiveBackground:'clear'}),snapshot:async()=>({}),onChange:()=>{},onVisibility:cb=>setTimeout(()=>cb(true),200)});`);
const env = { ...process.env, HUD_COMPOSITION_RUN: run };
delete env.ELECTRON_RUN_AS_NODE;
for (const name of ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) { env[name] = path.join(run, name); await mkdir(env[name], { recursive: true }); }
console.log("Isolated composition probe: " + run);
const result = await execute(path.join(project, "node_modules/electron/dist/electron.exe"), [path.join(run, "host.cjs")], env);
await writeFile(path.join(run, "electron.log"), result.output);
console.log(await readFile(path.join(run, "result.json"), "utf8").catch(() => result.output));
process.exitCode = result.code;
