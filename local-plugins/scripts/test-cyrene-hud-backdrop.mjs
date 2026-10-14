import { mkdir, readFile, writeFile, copyFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), project = path.dirname(root);
const run = path.join(root, ".test-runtime", `hud-backdrop-${Date.now()}`);
await mkdir(run, { recursive: true });
const framework = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319", metadata = "C:\\Windows\\System32\\WinMetadata";
const refs = ["System.Runtime", "System.Runtime.InteropServices.WindowsRuntime", "System.Runtime.WindowsRuntime", "System.Numerics", "System.Numerics.Vectors", "System.Drawing", "System.Windows.Forms"].map(name => "/r:" + path.join(framework, name + ".dll"));
refs.push(...(await readdir(metadata)).filter(name => name.endsWith(".winmd")).map(name => "/r:" + path.join(metadata, name)));
const source = await readFile(path.join(root, "plugins/cyrene-hud/native/GlassHost.cs"), "utf8");
const compare = process.argv.includes("--compare"), released = process.argv.includes("--release"), modes = compare ? ["before", "fixed"] : ["fixed"];
for (const mode of modes) {
  if (released) {
    const manifest = JSON.parse(await readFile(path.join(root, "plugins/cyrene-hud/manifest.json"), "utf8"));
    await copyFile(path.join(root, "releases", `cyrene-hud-${manifest.version}`, "cyrene-hud/GlassHost.exe"), path.join(run, mode + ".exe"));
    continue;
  }
  const file = path.join(run, mode + ".cs");
  await writeFile(file, mode === "before" ? source.replace("ExStyle = 0x082800A8", "ExStyle = 0x082800A0") : source);
  await promisify(execFile)(path.join(framework, "csc.exe"), ["/nologo", "/target:exe", "/platform:x64", "/out:" + path.join(run, mode + ".exe"), ...refs, file], { windowsHide: true });
}
await writeFile(path.join(run, "Capture.cs"), `using System;using System.Drawing;using System.Runtime.InteropServices;
class Capture { [StructLayout(LayoutKind.Sequential)] struct Rect {public int left,top,right,bottom;}
[DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
static void Main(string[] args) {SetProcessDpiAwarenessContext(new IntPtr(-4));Rect r;if(!GetWindowRect(new IntPtr(long.Parse(args[0])),out r))throw new Exception("Missing fixture owner");
int count=args.Length>2?int.Parse(args[2]):1;
using(var b=new Bitmap(r.right-r.left,r.bottom-r.top)) {using(var g=Graphics.FromImage(b))for(int i=0;i<count;i++){g.CopyFromScreen(r.left,r.top,0,0,b.Size);b.Save(count==1?args[1]:args[1]+"-"+i+".png",System.Drawing.Imaging.ImageFormat.Png);if(count>1)System.Threading.Thread.Sleep(33);}}
Console.WriteLine(GetForegroundWindow().ToInt64());}}
`);
await promisify(execFile)(path.join(framework, "csc.exe"), ["/nologo", "/target:exe", "/r:System.Drawing.dll", "/out:" + path.join(run, "Capture.exe"), path.join(run, "Capture.cs")], { windowsHide: true });
await copyFile(path.join(root, "scripts/hud-backdrop-host.cjs"), path.join(run, "host.cjs"));
const env = { ...process.env, CYRENE_BACKDROP_RUN: run, CYRENE_BACKDROP_MODES: JSON.stringify(modes) };
delete env.ELECTRON_RUN_AS_NODE;
for (const name of ["APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) { env[name] = path.join(run, name); await mkdir(env[name], { recursive: true }); }
const child = spawn(path.join(project, "node_modules/electron/dist/electron.exe"), [path.join(run, "host.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", chunk => log += chunk); child.stderr.on("data", chunk => log += chunk);
console.log("Backdrop test: " + run);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
await writeFile(path.join(run, "electron.log"), log);
console.log(await readFile(path.join(run, "result.json"), "utf8").catch(() => log)); process.exitCode = code ?? 1;
