import { build } from "esbuild";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), project = path.dirname(root);
const run = path.join(root, ".test-runtime", `hud-electron-${Date.now()}`);
await mkdir(run, { recursive: true });
await writeFile(path.join(run, "entry.ts"), `export {PluginManager} from ${JSON.stringify(path.join(project, "src/plugins/manager"))}; export {createPluginIpcRouter} from ${JSON.stringify(path.join(project, "src/plugins/ipc-router"))}; export {createPluginWindowNavigationService} from ${JSON.stringify(path.join(project, "src/main/plugin-host/window-navigation-service"))};`);
await build({ entryPoints: [path.join(run, "entry.ts")], outfile: path.join(run, "host-api.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", external: ["electron"], logLevel: "silent" });
const navigation = process.argv.includes("--navigation"), edition = process.argv.includes("--upstream") ? "upstream" : "local", localIpc = process.argv.includes("--local-ipc");
if (navigation && edition === "upstream") {
  const upstreamRoot = localIpc ? project : path.join(root, ".test-runtime/hud-upstream-9fcff7a");
  const endpoints = [
    ["src/main/chats/chats-ipc.ts", "CHATS_LIST", "chats:list", "handle"],
    ["src/main/chats/chats-ipc.ts", "CHATS_CREATE", "chats:create", "handle"],
    ["src/main/chats/chat-ui-ipc.ts", "CHATS_OPEN_IN_REACT_WINDOW", "chats:open-in-react-window", "handle"],
    localIpc ? ["src/main/windows/window-system-ipc.ts", "SIDEBAR_OPEN_SETTINGS", "sidebar:open-settings", "on"] : ["src/main/windows/window-system-ipc.ts", "SETTINGS_REQUEST_SWITCH_SECTION", "settings:request-switch-section", "handle"],
  ];
  let body = "";
  for (const [file, key, channel, method] of endpoints) {
    const source = ts.createSourceFile(file, await readFile(path.join(upstreamRoot, file), "utf8"), ts.ScriptTarget.Latest, true);
    let callback;
    const find = node => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === `ipc.${method}` && node.arguments[0]?.getText(source) === `IPC.${key}`) callback = node.arguments[1].getText(source);
      ts.forEachChild(node, find);
    };
    find(source); if (!callback) throw Error(`Upstream endpoint missing: ${channel}`);
    body += `ipc.${method}(${JSON.stringify(channel)}, ${callback});\n`;
  }
  await writeFile(path.join(run, "upstream-handlers.cjs"), ts.transpileModule(`exports.register = (ipc, chatsStore, deps, getDefaultModelProfile, broadcastChanged) => { const getSession = id => chatsStore.getSession(id); ${body} };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
  await copyFile(path.join(upstreamRoot, "src/plugins/manifest.schema.json"), path.join(run, "upstream-manifest.schema.json"));
}
const rings = process.argv.includes("--rings") || (!navigation && !process.argv.includes("--preview") && !process.argv.includes("--legacy"));
await copyFile(path.join(root, rings ? "scripts/hud-rings-host.cjs" : navigation ? "scripts/hud-navigation-host.cjs" : "scripts/hud-electron-host.cjs"), path.join(run, "host.cjs"));
const env = { ...process.env, CYRENE_HUD_EDITION: edition, CYRENE_HUD_LOCAL_IPC: localIpc ? "1" : "0", CYRENE_HUD_NATIVE_POINTER: process.argv.includes("--native-pointer") ? "1" : "0", CYRENE_HUD_ARTIFACTS: path.join(root, "artifacts"), CYRENE_HUD_PREVIEW: process.argv.includes("--preview") ? "1" : "0", APPDATA: path.join(run, "app-data"), LOCALAPPDATA: path.join(run, "local-app-data"), TEMP: path.join(run, "temp"), TMP: path.join(run, "temp") };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes("--release")) {
  const manifest = JSON.parse(await readFile(path.join(root, "plugins/cyrene-hud/manifest.json"), "utf8"));
  env.CYRENE_HUD_ARTIFACTS = path.join(root, "releases", `cyrene-hud-${manifest.version}`);
}
for (const name of ["APPDATA", "LOCALAPPDATA", "TEMP"]) await mkdir(env[name], { recursive: true });
const child = spawn(path.join(project, "node_modules/electron/dist/electron.exe"), [path.join(run, "host.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
console.log(`Isolated HUD: ${run}`);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
await writeFile(path.join(run, "electron.log"), logs);
try { console.log(await readFile(path.join(run, "result.json"), "utf8")); } catch { console.error(logs.slice(-4000)); }
console.log(`Report: ${run}`); process.exitCode = code ?? 1;
