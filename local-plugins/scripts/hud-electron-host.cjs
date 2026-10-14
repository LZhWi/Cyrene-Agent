"use strict";
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const processTools = require("node:child_process"), originalSpawn = processTools.spawn, glassChildren = [], glassMessages = [];
let simulatedSaver;
processTools.spawn = function(file, args, options) {
  const child = originalSpawn.call(this, file, args, options);
  if (file.endsWith("GlassHost.exe")) {
    const originalEmit = child.stdout.emit;
    child.stdout.emit = function(event, chunk, ...rest) {
      if (event === "data" && simulatedSaver !== undefined) chunk = Buffer.from(chunk.toString().replace(/"powerPaused":(?:true|false)/g, `"powerPaused":${simulatedSaver}`));
      return originalEmit.call(this, event, chunk, ...rest);
    };
    glassChildren.push(child); let pending = "";
    child.stdout.on("data", chunk => { pending += chunk; let end; while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); try { glassMessages.push(JSON.parse(line)); } catch {} } });
  }
  return child;
};
const { promisify } = require("node:util");
const { PluginManager, createPluginIpcRouter, createPluginWindowNavigationService } = require("./host-api.cjs");
const preview = process.env.CYRENE_HUD_PREVIEW === "1";
for (const name of ["userData", "sessionData", "logs"]) { fs.mkdirSync(path.join(__dirname, name), { recursive: true }); app.setPath(name, path.join(__dirname, name)); }
// Do not treat the last HUD window closing as permission to end a lifecycle test.
app.on("window-all-closed", () => {});
const checks = [], errors = [], router = createPluginIpcRouter(), channels = new Set(), ignored = new Map();
let manager, enabled = {}, snapshot, clickThroughConfigured = false, failSnapshot = false;
const forbidden = () => { throw Error("Model, tool, prompt, channel or conversation service accessed"); };
const originalIgnore = BrowserWindow.prototype.setIgnoreMouseEvents;
BrowserWindow.prototype.setIgnoreMouseEvents = function(value, options) { ignored.set(this.id, value); return originalIgnore.call(this, value, options); };
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _file, error) => errors.push(String(error)));
  contents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await test()) return; await sleep(100); } throw Error("Condition timed out"); }
const invoke = (id, name, ...args) => manager.invokePluginIpc(id, name, args);
async function inspectGlass(hud, name = "hud-native-glass", includeGlass = true) {
  const handle = includeGlass ? glassMessages.filter(message => message.ready).at(-1).handle : "0";
  const hudHandle = hud.getNativeWindowHandle().readBigUInt64LE().toString();
  const output = path.join(__dirname, name + ".png").replaceAll("'", "''");
  const script = `Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class HudWindows {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr p);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
}
'@
[HudWindows]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$hud=[IntPtr]${hudHandle}; $glass=[IntPtr]${handle}
$r=New-Object HudWindows+Rect; $g=New-Object HudWindows+Rect
[HudWindows]::GetWindowRect($hud,[ref]$r) | Out-Null
[HudWindows]::GetWindowRect($glass,[ref]$g) | Out-Null
$point=New-Object HudWindows+Point; $point.x=($r.left+$r.right)/2; $point.y=($r.top+$r.bottom)/2
$bitmap=New-Object Drawing.Bitmap ($r.right-$r.left),($r.bottom-$r.top)
$graphics=[Drawing.Graphics]::FromImage($bitmap)
try { $graphics.CopyFromScreen($r.left,$r.top,0,0,$bitmap.Size); $bitmap.Save('${output}') } finally { $graphics.Dispose(); $bitmap.Dispose() }
@{visible=[HudWindows]::IsWindowVisible($glass); enabled=[HudWindows]::IsWindowEnabled($glass); focused=([HudWindows]::GetForegroundWindow() -eq $glass); hit=[HudWindows]::GetAncestor([HudWindows]::WindowFromPoint($point),2).ToInt64().ToString(); glass='${handle}'; hud='${hudHandle}'; bounds=@($g.left,$g.top,$g.right,$g.bottom); expected=@($r.left,$r.top,$r.right,$r.bottom)} | ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10000 });
  return JSON.parse(stdout);
}
const hudWindow = () => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith("/hud.html"));
const panelWindow = () => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith("/settings.html"));
const deadline = setTimeout(() => { writeResult(false, "deadline"); app.exit(1); }, 90000);
function writeResult(ok, error) {
  fs.writeFileSync(path.join(__dirname, "result.json"), JSON.stringify({ ok, error, nativeElectron: true, checks, errors,
    modelServicesUsed: false, realUserDataUsed: false, clickThroughConfigured, actualPointerThroughVerified: false,
    multiDisplayInteractionVerified: false, glassMessages, snapshot }, null, 2));
}
async function finish() { await manager.stop(); clearTimeout(deadline); writeResult(true); app.exit(0); }

app.whenReady().then(async () => {
  ipcMain.handle("runtime-state:get", () => ({ status: "", feeling: "" }));
  ipcMain.handle("model-config:get", () => ({ runtimeSync: "off", connected: false }));
  const displayListeners = ["display-added", "display-removed", "display-metrics-changed"].map(event => screen.listenerCount(event));
  manager = new PluginManager({ scanRoots: [{ path: path.join(__dirname, "plugins"), source: "user" }], storageRoot: path.join(__dirname, "plugin-data"), loadEnabledMap: () => enabled, saveEnabledMap: map => { enabled = map; }, runtime: {
    toolRegistry: { register: forbidden, unregister: forbidden },
    channelManager: { has: forbidden, register: forbidden, unregister: forbidden, startOne: forbidden },
    promptRegistry: { register: forbidden, unregister: forbidden, registerStable: forbidden, unregisterStable: forbidden },
    hostServices: { createForPlugin: ({ signal }) => ({ windowNavigation: createPluginWindowNavigationService({ signal, listSessions: () => [], createSession: forbidden, windows: { openReactChatWindow: forbidden, openReactWorkspaceWindow: forbidden, createSettingsWindow: forbidden } }) }) },
    registerIpc: (channel, fn) => {
      channels.add(channel);
      router.register(channel, (...args) => {
        if (failSnapshot && channel === "plugin:cyrene-hud:snapshot") throw Error("Synthetic snapshot failure");
        return fn(...args);
      });
      ipcMain.handle(channel, (_event, ...args) => router.invokeRegistered(channel, args));
    },
    unregisterIpc: channel => { channels.delete(channel); router.unregister(channel); ipcMain.removeHandler(channel); },
    invokeIpc: (channel, args) => router.invokeRegistered(channel, args),
  } });
  await manager.start();
  const installed = await manager.installZip(path.join(process.env.CYRENE_HUD_ARTIFACTS, "cyrene-hud.zip"));
  assert.equal(installed.ok, true, installed.error); assert.equal(manager.isRunning("cyrene-hud"), false);
  assert.deepEqual(manager.list().map(plugin => plugin.id), ["cyrene-hud"]);
  checks.push("Actual PluginManager imports only the standalone HUD ZIP; defaults disabled; no system-status installed");
  const activated = await manager.setEnabled("cyrene-hud", true); assert.equal(activated.ok, true, activated.error);
  const hud = hudWindow(); assert.ok(hud); assert.equal(hud.isFocusable(), false); assert.equal(hud.isAlwaysOnTop(), true); assert.equal(ignored.get(hud.id), true);
  if (preview) {
    await manager.open("cyrene-hud");
    const previewPanel = panelWindow();
    invoke("cyrene-hud", "save", { ...invoke("cyrene-hud", "state").config, mode: "persistent" });
    clearTimeout(deadline); checks.push("Isolated interactive preview with real hardware; close settings to exit"); writeResult(true);
    previewPanel.once("closed", () => { void finish(); }); return;
  }
  assert.deepEqual(invoke("cyrene-hud", "state").config, { metric: "memory", mode: "hover", hoverDelay: .35, displayDuration: 4, hideTrigger: "trigger", avatarTarget: "none", avatarSession: "new", avatarSessionId: null, position: "top-center", displayId: null, width: 408, height: 60, radius: 30, background: "acrylic", backgroundColor: "#f9f4f8", tintOpacity: .2, scale: 1, opacity: .8, clickThrough: true });
  assert.equal(hud.isVisible(), false);
  checks.push("Fresh ZIP installation starts hidden with the user's chosen memory, hover, 408x60 rounded glass appearance as defaults");
  clickThroughConfigured = true;
  const prefs = hud.webContents.getLastWebPreferences(); assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false);
  assert.equal(await hud.webContents.executeJavaScript("typeof require"), "undefined");
  assert.deepEqual([...channels].filter(name => name.startsWith("plugin:")).sort(), ["plugin:cyrene-hud:avatar-hover", "plugin:cyrene-hud:list-sessions", "plugin:cyrene-hud:open-target", "plugin:cyrene-hud:preview", "plugin:cyrene-hud:save", "plugin:cyrene-hud:snapshot", "plugin:cyrene-hud:state"]);
  checks.push("Standalone plugin activates without any model/tool/prompt services; all IPC belongs to HUD; sandbox exposes no Node");
  if (process.env.CYRENE_HUD_DEFAULTS_ONLY === "1") { await finish(); return; }
  if (process.env.CYRENE_HUD_HOVER_ONLY === "1") {
    const originalCursor = screen.getCursorScreenPoint, area = screen.getPrimaryDisplay().bounds;
    const inside = { x: area.x + Math.round(area.width / 2), y: area.y }, outside = { x: area.x + 100, y: area.y + 100 };
    let cursor = outside;
    screen.getCursorScreenPoint = () => cursor;
    try {
      invoke("cyrene-hud", "save", { ...invoke("cyrene-hud", "state").config, metric: "clock", background: "solid" });
      await sleep(100);
      const start = Date.now(); cursor = inside;
      await sleep(150); assert.equal(hud.isVisible(), false);
      await until(() => hud.isVisible(), 1000);
      const elapsed = Date.now() - start; assert.ok(elapsed >= 350 && elapsed < 700, `Default dwell took ${elapsed}ms`);
      checks.push("Real Electron HUD waits the default 0.35 seconds before showing with a simulated cursor; it does not activate");
      assert.equal(hud.isFocused(), false);
      cursor = outside;
      invoke("cyrene-hud", "save", invoke("cyrene-hud", "state").config);
      await sleep(100); cursor = inside; await sleep(150); cursor = outside;
      await sleep(500); assert.equal(hud.isVisible(), false);
      checks.push("Leaving the hot zone before dwell completes cancels the pending native window reveal (simulated cursor)");
      assert.equal((await manager.open("cyrene-hud")).ok, true);
      const panel = panelWindow();
      await until(async () => await panel.webContents.executeJavaScript("document.querySelector('#hoverDelay').value === '0.35'"));
      await panel.webContents.executeJavaScript("document.querySelector('#hoverDelay').value='0.6'; document.querySelector('#form').requestSubmit()");
      await until(() => invoke("cyrene-hud", "state").config.hoverDelay === .6);
      assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, "plugin-data/cyrene-hud/settings.json"), "utf8")).hoverDelay, .6);
      await sleep(100); cursor = inside;
      await sleep(450); assert.equal(hud.isVisible(), false);
      await until(() => hud.isVisible(), 1000);
      cursor = outside;
      invoke("cyrene-hud", "save", invoke("cyrene-hud", "state").config);
      invoke("cyrene-hud", "preview"); assert.equal(hud.isVisible(), true);
      await panel.webContents.executeJavaScript("document.querySelector('#displayDuration').value='0.5'; document.querySelector('#hideTrigger').value='trigger-and-window'; document.querySelector('#form').requestSubmit()");
      await until(() => invoke("cyrene-hud", "state").config.displayDuration === .5 && invoke("cyrene-hud", "state").config.hideTrigger === "trigger-and-window");
      const savedTiming = JSON.parse(fs.readFileSync(path.join(__dirname, "plugin-data/cyrene-hud/settings.json"), "utf8"));
      assert.equal(savedTiming.displayDuration, .5); assert.equal(savedTiming.hideTrigger, "trigger-and-window");
      const b = hud.getBounds(), overWindow = { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) };
      cursor = inside; await until(() => hud.isVisible(), 1200);
      cursor = overWindow; await sleep(1000); assert.equal(hud.isVisible(), true);
      cursor = outside; await sleep(250); assert.equal(hud.isVisible(), true);
      await until(() => !hud.isVisible(), 1000);
      checks.push("Sandboxed settings save 0.5-second display duration; trigger-and-window timing holds the click-through HUD while the simulated cursor is over its native bounds");
      cursor = overWindow; invoke("cyrene-hud", "preview");
      await sleep(200); cursor = outside; await sleep(250); cursor = overWindow;
      await sleep(900); assert.equal(hud.isVisible(), true);
      checks.push("Returning to the native HUD window cancels the pending hide countdown and preview uses the chosen timing policy (simulated cursor)");
      await panel.webContents.executeJavaScript("document.querySelector('#hideTrigger').value='trigger'; document.querySelector('#form').requestSubmit()");
      await until(() => invoke("cyrene-hud", "state").config.hideTrigger === "trigger");
      cursor = inside; await until(() => hud.isVisible(), 1200);
      cursor = overWindow; await until(() => !hud.isVisible(), 1400);
      checks.push("Trigger-only timing hides the native HUD despite the simulated cursor remaining over the window");
      await panel.webContents.executeJavaScript("document.querySelector('#mode').value='persistent'; document.querySelector('#mode').dispatchEvent(new Event('input'))");
      assert.equal(await panel.webContents.executeJavaScript("['hoverDelay','displayDuration','hideTrigger'].every(id => document.getElementById(id).disabled)"), true);
      await panel.webContents.executeJavaScript("document.querySelector('#mode').value='hover'; document.querySelector('#mode').dispatchEvent(new Event('input')); document.querySelector('#hideTrigger').value='trigger-and-window'; document.querySelector('#form').requestSubmit()");
      await until(() => invoke("cyrene-hud", "state").config.hideTrigger === "trigger-and-window");
      cursor = outside;
      await manager.setEnabled("cyrene-hud", false);
      await manager.setEnabled("cyrene-hud", true);
      assert.equal(invoke("cyrene-hud", "state").config.hoverDelay, .6);
      assert.equal(invoke("cyrene-hud", "state").config.displayDuration, .5);
      assert.equal(invoke("cyrene-hud", "state").config.hideTrigger, "trigger-and-window");
      assert.equal(hudWindow().isVisible(), false);
      assert.equal(errors.length, 0, JSON.stringify(errors));
      checks.push("Custom dwell, display duration and hide policy survive re-enable; persistent mode disables timing controls; preview remains immediate");
    } finally { screen.getCursorScreenPoint = originalCursor; }
    await finish(); return;
  }

  const { WINDOWS_SCRIPT } = require(path.join(__dirname, "plugins/cyrene-hud/collector.cjs"));
  const aggregate = WINDOWS_SCRIPT.match(/if \(\$net.Count\).*?\} else \{ \$r.net = \$null \}/)[0];
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$r=@{}; $net=@([pscustomobject]@{ReceivedBytes=100;SentBytes=20},[pscustomobject]@{ReceivedBytes=200;SentBytes=30}); " + aggregate + "; $r.net | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 10000 });
  assert.deepEqual(JSON.parse(stdout), { r: 300, s: 50 }); checks.push("Real PowerShell executes corrected aggregation: received=300, sent=50 (synthetic adapters)");

  await until(async () => {
    snapshot = await invoke("cyrene-hud", "snapshot");
    return snapshot.cpuPercent !== null;
  });
  assert.ok(snapshot.memoryTotalGb > 0); assert.ok(snapshot.memoryPercent >= 0 && snapshot.memoryPercent <= 100);
  assert.ok(snapshot.disks.length > 0, "Real Windows disk query did not succeed");
  assert.ok(Number.isFinite(snapshot.networkBytesPerSecond), "Real network counter difference unavailable");
  checks.push("Real Windows samples returned CPU, memory, disk and network data; GPU/battery remain capability-dependent");

  const state = invoke("cyrene-hud", "state");
  invoke("cyrene-hud", "save", { ...state.config, metric: "memory", mode: "persistent" });
  await until(async () => await hud.webContents.executeJavaScript("document.querySelector('#label').textContent === '内存' && document.querySelector('#status').textContent === '实时'"));
  await sleep(600); fs.writeFileSync(path.join(__dirname, "hud.png"), (await hud.webContents.capturePage()).toPNG());
  assert.equal((await manager.open("cyrene-hud")).ok, true);
  const panel = panelWindow(); assert.ok(panel);
  await until(async () => await panel.webContents.executeJavaScript("document.querySelector('#metric').value === 'memory'"));
  await panel.webContents.executeJavaScript("document.querySelector('#metric').value='gpu'; document.querySelector('#form').requestSubmit()");
  await until(() => invoke("cyrene-hud", "state").config.metric === "gpu");
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, "plugin-data/cyrene-hud/settings.json"), "utf8")).metric, "gpu");
  await sleep(600); fs.writeFileSync(path.join(__dirname, "settings.png"), (await panel.webContents.capturePage()).toPNG());
  invoke("cyrene-hud", "preview"); assert.equal(hud.isFocused(), false);
  checks.push("Native sandboxed settings page saves through IPC and private storage; HUD preview cannot take focus");
  assert.notEqual(hud.webContents.session, panel.webContents.session);
  invoke("cyrene-hud", "save", { ...state.config, scale: 1.2, opacity: 0.8, clickThrough: false, mode: "persistent" });
  assert.ok(Math.abs(hud.webContents.getZoomFactor() - 1.2) < 0.01);
  assert.equal(panel.webContents.getZoomFactor(), 1); assert.equal(ignored.get(hud.id), false);
  invoke("cyrene-hud", "save", { ...state.config, mode: "persistent" }); assert.equal(ignored.get(hud.id), true);
  checks.push("HUD scaling uses a separate in-memory browser session; settings zoom stays unchanged; click-through toggle applies");

  await panel.webContents.executeJavaScript("document.querySelector('#width').value='520'; document.querySelector('#height').value='180'; document.querySelector('#radius').value='70'; document.querySelector('#background').value='clear'; document.querySelector('#form').requestSubmit()");
  await until(() => invoke("cyrene-hud", "state").config.width === 520);
  await until(async () => await hud.webContents.executeJavaScript("getComputedStyle(document.querySelector('#hud')).borderTopLeftRadius === '70px' && document.body.dataset.background === 'clear'"));
  assert.deepEqual(hud.getSize(), [552, 222]);
  const savedAppearance = JSON.parse(fs.readFileSync(path.join(__dirname, "plugin-data/cyrene-hud/settings.json"), "utf8"));
  assert.equal(savedAppearance.radius, 70); assert.equal(savedAppearance.background, "clear");
  await sleep(600); fs.writeFileSync(path.join(__dirname, "hud-custom.png"), (await hud.webContents.capturePage()).toPNG());
  if (process.env.CYRENE_HUD_QQ_INFO) {
    const qq = JSON.parse(fs.readFileSync(process.env.CYRENE_HUD_QQ_INFO, "utf8").replace(/^\uFEFF/, "")).find(row => row.app === "QQ" && row.visible);
    assert.ok(qq && /^\d+$/.test(qq.handle), "Visible QQ main window is required");
    const layer = async (action, previous = "0") => promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", process.env.CYRENE_HUD_QQ_LAYER, action, qq.handle, String(previous)], { windowsHide: true, timeout: 10000 });
    const { stdout } = await layer("raise"), previous = JSON.parse(stdout).previous;
    const results = [];
    try {
      const corner = screen.screenToDipPoint({ x: qq.bounds[0], y: qq.bounds[1] });
      for (const [profile, offset] of [["partial-title", -30], ["title", 5], ["content", 75]]) for (const background of ["clear", "acrylic"]) {
        invoke("cyrene-hud", "save", { ...savedAppearance, metric: "memory", background, width: 408, height: 60, radius: 30, scale: 1, backgroundColor: "#f9f4f8", tintOpacity: .2, opacity: .8, mode: "persistent" });
        await until(() => invoke("cyrene-hud", "state").glassStatus === "ready");
        const padded = background === "clear";
        hud.setBounds({ x: Math.round(corner.x + 5 - (padded ? 16 : 0)), y: Math.round(corner.y + offset - (padded ? 21 : 0)), width: padded ? 440 : 408, height: padded ? 102 : 60 });
        hud.moveTop(); await sleep(600);
        const name = `qq-${profile}-${background}`;
        const windows = await inspectGlass(hud, name, !padded);
        assert.equal(windows.hit, qq.handle, "QQ must be the actual window beneath the test HUD");
        const image = require("electron").nativeImage.createFromPath(path.join(__dirname, name + ".png")), data = image.toBitmap(), size = image.getSize();
        const scale = size.width / hud.getBounds().width, values = [];
        for (const y of [4, 55]) for (let x = 75; x < 325; x++) {
          const index = (Math.round((y + (padded ? 21 : 0)) * scale) * size.width + Math.round((x + (padded ? 16 : 0)) * scale)) * 4;
          values.push(data[index]);
        }
        const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
        results.push({ profile, background, mean, variation: values.slice(1).reduce((sum, v, index) => sum + Math.abs(v - values[index]), 0) / (values.length - 1), windows });
      }
      fs.writeFileSync(path.join(__dirname, "qq-blur.json"), JSON.stringify({ actualQqWindow: true, temporarilyTopmost: true, systemMaterial: qq.material, results }, null, 2));
      const sharp = results.find(item => item.profile === "partial-title" && item.background === "clear");
      const blurred = results.find(item => item.profile === "partial-title" && item.background === "acrylic");
      assert.ok(sharp.variation > 2 && blurred.variation < sharp.variation * .45, "QQ title content must blur: " + JSON.stringify({ sharp: sharp.variation, blurred: blurred.variation }));
      checks.push("Actual QQ main window compared under clear/glass HUD at title, partial overlap and content positions; original QQ window order restored");
    } finally { await layer("restore", previous); }
    await finish(); return;
  }
  for (const background of ["acrylic", "mica"]) {
    invoke("cyrene-hud", "save", { ...savedAppearance, background });
    const currentState = invoke("cyrene-hud", "state");
    const materialSupported = currentState.materialSupported && !(background === "acrylic" && currentState.powerPaused);
    const expectedBackground = materialSupported ? background : currentState.materialSupported && currentState.powerPaused ? "clear" : "solid";
    await until(async () => await hud.webContents.executeJavaScript(`document.body.dataset.background === '${expectedBackground}'`));
    assert.deepEqual(hud.getSize(), materialSupported ? [520, 180] : [552, 222]);
    await until(async () => await panel.webContents.executeJavaScript(`document.querySelector('#radius').disabled === ${materialSupported && background === "mica"}`));
    if (background === "acrylic" && materialSupported) {
      await until(() => invoke("cyrene-hud", "state").glassStatus === "ready");
      await until(() => glassMessages.some(message => message.synced && message.visible));
      assert.equal(glassMessages.some(message => message.focused), false, "Native glass activated itself");
      invoke("cyrene-hud", "save", { ...savedAppearance, background, backgroundColor: "#191c2a", tintOpacity: .75 });
      await until(async () => await hud.webContents.executeJavaScript("document.body.classList.contains('dark-tint') && getComputedStyle(document.querySelector('#hud')).borderTopLeftRadius === '70px'"));
      await sleep(400); fs.writeFileSync(path.join(__dirname, "hud-glass-dark.png"), (await hud.webContents.capturePage()).toPNG());
      const b = hud.getBounds();
      const nestedMaterial = process.env.CYRENE_HUD_NESTED_MATERIAL || "none";
      const fixture = new BrowserWindow({ x: b.x - 20, y: b.y - 20, width: b.width + 40, height: b.height + 40, frame: false, show: false, transparent: nestedMaterial === "none", backgroundMaterial: nestedMaterial, backgroundColor: "#00000000", webPreferences: { sandbox: true, backgroundThrottling: false } });
      await fixture.loadURL("data:text/html," + encodeURIComponent('<body style="margin:0;height:100vh;background:#111827"></body>'));
      fixture.setAlwaysOnTop(true); fixture.showInactive(); fixture.moveTop(); hud.moveTop();
      await sleep(600);
      const inspected = await inspectGlass(hud);
      fs.writeFileSync(path.join(__dirname, "native-hit-test.json"), JSON.stringify(inspected, null, 2));
      const shot = require("electron").nativeImage.createFromPath(path.join(__dirname, "hud-native-glass.png"));
      const pixels = shot.toBitmap(), size = shot.getSize();
      const corners = [[3, 3], [size.width - 4, 3], [3, size.height - 4], [size.width - 4, size.height - 4]].map(([x, y]) => [...pixels.subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 3)]);
      fs.writeFileSync(path.join(__dirname, "corner-pixels.json"), JSON.stringify(corners));
      for (const pixel of corners) assert.ok(pixel.every((value, channel) => Math.abs(value - [39, 24, 17][channel]) <= 3), "Round corners must expose the dark fixture, got " + JSON.stringify(corners));
      assert.equal(inspected.focused, false); assert.equal(inspected.visible, true);
      assert.deepEqual(inspected.bounds, inspected.expected);
      assert.notEqual(inspected.hit, inspected.glass); assert.notEqual(inspected.hit, inspected.hud);
      assert.equal(inspected.hit, fixture.getNativeWindowHandle().readBigUInt64LE().toString());
      // An opaque app with fine stripes catches missing blur that uniform colors cannot.
      await fixture.webContents.executeJavaScript("document.body.style.background = 'repeating-linear-gradient(90deg,#101010 0 4px,#f0f0f0 4px 8px)'");
      await fixture.webContents.capturePage();
      const blurCases = [];
      for (const [mode, topmost, opacity, partial, focused] of [["clear", true, 1, false], ["acrylic", true, 1, false], ["acrylic", false, 1, false], ["acrylic", false, .8, false], ["acrylic", true, .8, false], ["clear", false, .8, true], ["acrylic", false, .8, true], ["acrylic", false, .8, true, true]]) {
        fixture.setBounds({ x: b.x - 20, y: partial ? b.y + 30 : b.y - 20, width: b.width + 40, height: b.height + 40 });
        fixture.setAlwaysOnTop(topmost); fixture.moveTop();
        invoke("cyrene-hud", "save", { ...savedAppearance, background: mode, width: 408, height: 60, radius: 30, scale: 1, backgroundColor: "#f9f4f8", tintOpacity: .2, opacity, mode: focused ? "hover" : "persistent" });
        if (focused) { fixture.focus(); invoke("cyrene-hud", "preview"); }
        await until(() => invoke("cyrene-hud", "state").glassStatus === "ready");
        hud.moveTop(); await sleep(500);
        const name = "hud-app-blur-" + mode + (topmost ? "-topmost" : "-ordinary") + "-" + opacity + (partial ? "-partial" : "") + (focused ? "-focused-hover" : "");
        await inspectGlass(hud, name, mode === "acrylic");
        const image = require("electron").nativeImage.createFromPath(path.join(__dirname, name + ".png"));
        const data = image.toBitmap(), size = image.getSize(), scale = size.width / hud.getBounds().width;
        const left = (mode === "clear" ? 16 : 0) * scale, top = (mode === "clear" ? 21 : 0) * scale;
        const row = Math.round(top + 55 * scale), values = [];
        for (let x = Math.round(left + 160 * scale); x < left + 290 * scale; x++) values.push(data[(row * size.width + x) * 4]);
        const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
        const deviation = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
        blurCases.push({ mode, nestedMaterial, topmost, opacity, partial, focused: !!focused, mean, deviation });
      }
      fs.writeFileSync(path.join(__dirname, "app-blur.json"), JSON.stringify(blurCases, null, 2));
      assert.ok(blurCases[0].deviation > 50, "Clear control must retain the app's stripes");
      for (const blurred of blurCases.filter(item => item.mode === "acrylic")) {
        assert.ok(blurred.mean > 60 && blurred.mean < 230, "Glass must sample the app's pixels");
        assert.ok(blurred.deviation < blurCases[0].deviation * .45, "Glass must blur another app's fine stripes: " + JSON.stringify(blurCases));
      }
      fixture.setBounds({ x: b.x - 20, y: b.y - 20, width: b.width + 40, height: b.height + 40 });
      fixture.setAlwaysOnTop(true); fixture.moveTop(); hud.moveTop();
      checks.push(`Native desktop screenshots confirm app fine stripes blur with ${nestedMaterial} backdrop, ordinary/topmost windows, 80/100% opacity, partial overlap and focused hover preview`);
      if (process.env.CYRENE_HUD_BLUR_ONLY === "1") { fixture.destroy(); await finish(); return; }
      const adaptive = [];
      for (const mode of ["acrylic", "clear"]) {
        invoke("cyrene-hud", "save", { ...savedAppearance, background: mode, width: 340, height: 60, radius: 24, scale: 1, backgroundColor: "#fffbfc", tintOpacity: .2, opacity: 1 });
        await until(() => invoke("cyrene-hud", "state").glassStatus === "ready");
        hud.moveTop();
        for (const [name, color, lightAvatar] of [["dark", "#111827", true], ["gray", "#808080", false], ["light", "#ffffff", false]]) {
          await fixture.webContents.executeJavaScript(`document.body.style.background = '${color}'`);
          await fixture.webContents.capturePage();
          await until(async () => {
            const lum = invoke("cyrene-hud", "state").backdropLuminance;
            return Number.isFinite(lum) && (lightAvatar ? lum < 130 : name === "light" ? lum > 210 : lum >= 145 && lum < 200) && await hud.webContents.executeJavaScript(`document.body.classList.contains('light-avatar') === ${lightAvatar}`);
          }).catch(async error => {
            await inspectGlass(hud, `hud-failed-${mode}-${name}`, mode === "acrylic");
            fs.writeFileSync(path.join(__dirname, "failed-state.json"), JSON.stringify(invoke("cyrene-hud", "state"), null, 2));
            throw error;
          });
          const colors = await hud.webContents.executeJavaScript(`({
            avatar: getComputedStyle(document.querySelector('.mark .avatar')).backgroundColor,
            text: getComputedStyle(document.querySelector('#value')).color,
            label: getComputedStyle(document.querySelector('#label')).color,
            ring: getComputedStyle(document.querySelector('#progress')).stroke,
            symbol: getComputedStyle(document.querySelector('#symbol')).color
          })`);
          assert.equal(colors.avatar, lightAvatar ? "rgb(255, 192, 216)" : "rgb(255, 91, 138)");
          assert.equal(colors.text, lightAvatar ? "rgb(246, 232, 238)" : "rgb(79, 74, 87)");
          assert.equal(colors.label, lightAvatar ? "rgb(246, 232, 238)" : "rgb(111, 104, 118)");
          assert.equal(colors.ring, lightAvatar ? "rgb(245, 211, 224)" : "rgb(245, 139, 171)");
          assert.equal(colors.symbol, lightAvatar ? "rgb(245, 211, 224)" : "rgb(156, 98, 123)");
          const brightness = invoke("cyrene-hud", "state").backdropLuminance;
          if (mode === "clear" && name === "gray") assert.ok(brightness < 165, "Gray regression must exercise the old hysteresis range");
          adaptive.push({ mode, background: name, luminance: brightness, ...colors });
          await inspectGlass(hud, `hud-adaptive-${mode}-${name}`, mode === "acrylic");
        }
        hud.hide(); await sleep(200);
        const before = glassMessages.filter(message => Number.isFinite(message.luminance)).length;
        await sleep(1200);
        assert.equal(glassMessages.filter(message => Number.isFinite(message.luminance)).length, before, "Hidden HUD must not sample pixels");
        hud.showInactive();
        for (const [color, behind, lightAvatar] of [["#191c2a", "#ffffff", true], ["#fffbfc", "#111827", false]]) {
          await fixture.webContents.executeJavaScript(`document.body.style.background = '${behind}'`);
          invoke("cyrene-hud", "save", { ...savedAppearance, background: mode, width: 340, height: 60, radius: 24, scale: 1, backgroundColor: color, tintOpacity: .9, opacity: 1 });
          hud.moveTop();
          await until(async () => {
            const lum = invoke("cyrene-hud", "state").backdropLuminance;
            return Number.isFinite(lum) && (lightAvatar ? lum < 145 : lum > 165) && await hud.webContents.executeJavaScript(`document.body.classList.contains('light-avatar') === ${lightAvatar}`);
          });
          adaptive.push({ mode, tint: color, luminance: invoke("cyrene-hud", "state").backdropLuminance, lightAvatar });
        }
      }
      fs.writeFileSync(path.join(__dirname, "adaptive-avatar.json"), JSON.stringify(adaptive, null, 2));
      await fixture.webContents.executeJavaScript("document.body.style.background = '#ffffff'");
      await fixture.webContents.capturePage();
      const backgroundCases = [];
      for (const mode of ["persistent", "hover"]) for (const color of ["#f9f4f8", "#191c2a"]) {
        invoke("cyrene-hud", "save", { ...savedAppearance, background: "acrylic", width: 408, height: 60, radius: 30, scale: 1, backgroundColor: color, tintOpacity: .2, opacity: .8, mode });
        invoke("cyrene-hud", "preview");
        hud.moveTop(); await sleep(1500);
        const name = `hud-opacity-${mode}-${color.slice(1)}`;
        await inspectGlass(hud, name);
        const image = require("electron").nativeImage.createFromPath(path.join(__dirname, name + ".png")), bitmap = image.toBitmap(), size = image.getSize();
        const offset = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4;
        const pixel = [...bitmap.subarray(offset, offset + 3)];
        backgroundCases.push({ mode, color, pixel });
        if (color === "#f9f4f8") assert.ok(pixel.every(channel => channel > 160), "Light tint on a white backdrop must not become black at 80% opacity: " + JSON.stringify(backgroundCases));
      }
      fs.writeFileSync(path.join(__dirname, "background-colors.json"), JSON.stringify(backgroundCases, null, 2));
      checks.push("Light/dark background colors remain adjustable at 20% tint and 80% content opacity in persistent/hover glass");
      await fixture.webContents.executeJavaScript("document.body.style.background = '#111827'");
      checks.push("Dark/gray/light fixtures switch avatar, text and ring colors together in glass/clear modes, including the old gray hysteresis range and opposing tints; hidden HUD pauses sampling");
      for (const [radius, scale, color] of [[24, 1.2, "#fffbfc"], [0, 1, "#fffbfc"]]) {
        invoke("cyrene-hud", "save", { ...savedAppearance, background, width: 408, height: 118, radius, scale, backgroundColor: color, tintOpacity: .35 });
        await until(() => invoke("cyrene-hud", "state").glassStatus === "ready");
        hud.moveTop();
        await sleep(600);
        const name = radius ? "hud-corners-scaled" : "hud-corners-square";
        await inspectGlass(hud, name);
        const img = require("electron").nativeImage.createFromPath(path.join(__dirname, name + ".png"));
        const data = img.toBitmap(), size = img.getSize();
        const center = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4;
        assert.ok(Math.abs(data[center] - 39) > 20, "HUD must remain above the dark test fixture");
        const corners = [[3, 3], [size.width - 4, 3], [3, size.height - 4], [size.width - 4, size.height - 4]].map(([x, y]) => [...data.subarray((y * size.width + x) * 4, (y * size.width + x) * 4 + 3)]);
        for (const pixel of corners) assert.equal(pixel.every((value, channel) => Math.abs(value - [39, 24, 17][channel]) <= 3), radius !== 0, `${name}: ${JSON.stringify(corners)}`);
      }
      checks.push("All four corners expose the dark background at different radii/scales; zero radius restores square corners");
      for (const mode of ["solid", "clear"]) {
        invoke("cyrene-hud", "save", { ...savedAppearance, background: mode, width: 408, height: 118, radius: 24, scale: 1.2, backgroundColor: "#fffbfc", opacity: 1 });
        hud.moveTop(); await sleep(600);
        await inspectGlass(hud, "hud-smooth-" + mode, false);
        const img = require("electron").nativeImage.createFromPath(path.join(__dirname, "hud-smooth-" + mode + ".png"));
        const data = img.toBitmap(), size = img.getSize();
        for (const [x, y] of [[3, 3], [size.width - 4, 3], [3, size.height - 4], [size.width - 4, size.height - 4]]) {
          const offset = (y * size.width + x) * 4;
          assert.ok([0, 1, 2].every(channel => Math.abs(data[offset + channel] - [39, 24, 17][channel]) <= 3), mode + " must not have an outer rectangle");
        }
        if (mode === "solid") {
          const key = await hud.webContents.insertCSS(".hud {box-shadow:none!important;border:0!important}");
          await sleep(200);
          const rect = await hud.webContents.executeJavaScript("(()=>{const r=document.querySelector('#hud').getBoundingClientRect();return {x:r.x,y:r.y,ratio:devicePixelRatio}})()");
          const page = await hud.webContents.capturePage(), bitmap = page.toBitmap(), width = page.getSize().width;
          let partialAlpha = 0;
          for (let y = Math.ceil(rect.y * rect.ratio); y < (rect.y + 24) * rect.ratio; y++) for (let x = Math.ceil(rect.x * rect.ratio); x < (rect.x + 24) * rect.ratio; x++) {
            const alpha = bitmap[(y * width + x) * 4 + 3]; if (alpha > 0 && alpha < 255) partialAlpha++;
          }
          assert.ok(partialAlpha > 10, "Rounded edge must retain partial-alpha antialiasing");
          fs.writeFileSync(path.join(__dirname, "edge-antialias.json"), JSON.stringify({ partialAlpha }));
          await hud.webContents.removeInsertedCSS(key);
        }
      }
      invoke("cyrene-hud", "save", { ...savedAppearance, background, backgroundColor: "#191c2a", tintOpacity: .75 });
      await until(() => invoke("cyrene-hud", "state").glassStatus === "ready");
      checks.push("Pure and transparent backgrounds retain clear exterior pixels after switching; rounded edges contain antialiased alpha pixels without native hard clipping");
      fixture.destroy();
      checks.push("Win32 confirms native glass matches HUD bounds, stays unfocused and allows hit-testing through both layers to the fixture");
      invoke("cyrene-hud", "save", { ...savedAppearance, background, mode: "hover" });
      await sleep(250); const hidden = await inspectGlass(hud, "hud-hidden"); assert.equal(hidden.visible, false);
      invoke("cyrene-hud", "preview"); await sleep(250);
      assert.equal((await inspectGlass(hud, "hud-glass-preview")).visible, true);
      glassChildren.at(-1).kill();
      await until(() => invoke("cyrene-hud", "state").glassStatus === "failed");
      assert.equal(invoke("cyrene-hud", "state").effectiveBackground, "solid");
      checks.push("Glass follows hover visibility and a killed native helper falls back to a solid HUD without a restart loop");
    }
    if (background === "acrylic" && currentState.materialSupported) {
      // The preceding failure regression deliberately killed the old helper.
      invoke("cyrene-hud", "save", { ...savedAppearance, background: "solid" });
      invoke("cyrene-hud", "save", { ...savedAppearance, background: "acrylic", mode: "persistent" });
      await until(() => invoke("cyrene-hud", "state").glassStatus === "ready");
      const realSaver = invoke("cyrene-hud", "state").powerPaused;
      if (!realSaver) {
        simulatedSaver = true;
        glassChildren.at(-1).stdout.emit("data", Buffer.from('{"powerPaused":true}\n'));
        await until(() => invoke("cyrene-hud", "state").effectiveBackground === "clear");
      }
      const bounds = hud.getBounds(), fallbackPixels = [];
      const fixture = new BrowserWindow({ x: bounds.x - 20, y: bounds.y - 20, width: bounds.width + 40, height: bounds.height + 40, frame: false, show: false, backgroundColor: "#ffffff", webPreferences: { sandbox: true, backgroundThrottling: false } });
      await fixture.loadURL("data:text/html,<body style='margin:0;background:white;height:100vh'></body>");
      fixture.setAlwaysOnTop(true); fixture.showInactive(); fixture.moveTop();
      for (const mode of ["persistent", "hover"]) for (const color of ["#f9f4f8", "#191c2a"]) {
        invoke("cyrene-hud", "save", { ...savedAppearance, background: "acrylic", width: 408, height: 60, radius: 30, scale: 1, backgroundColor: color, tintOpacity: .2, opacity: .8, mode });
        invoke("cyrene-hud", "preview"); hud.moveTop(); await sleep(600);
        assert.equal(invoke("cyrene-hud", "state").effectiveBackground, "clear");
        assert.equal(invoke("cyrene-hud", "state").config.background, "acrylic");
        const name = `hud-power-fallback-${mode}-${color.slice(1)}`;
        await inspectGlass(hud, name, false);
        const image = require("electron").nativeImage.createFromPath(path.join(__dirname, name + ".png")), bitmap = image.toBitmap(), size = image.getSize();
        const offset = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4;
        const pixel = [...bitmap.subarray(offset, offset + 3)];
        fallbackPixels.push({ mode, color, pixel });
        if (color === "#f9f4f8") assert.ok(pixel.every(channel => channel > 160), "Light background must remain light during battery saver");
      }
      assert.ok(fallbackPixels[0].pixel[2] - fallbackPixels[1].pixel[2] > 15, "Custom tint must remain adjustable during fallback");
      fs.writeFileSync(path.join(__dirname, "background-colors.json"), JSON.stringify(fallbackPixels, null, 2));
      await until(async () => await panel.webContents.executeJavaScript("document.querySelector('#materialNote').textContent.includes('节能')"));
      const helper = glassChildren.at(-1);
      if (!realSaver) simulatedSaver = false;
      helper.stdout.emit("data", Buffer.from('{"powerPaused":false}\n'));
      assert.equal(invoke("cyrene-hud", "state").effectiveBackground, "acrylic", "Simulated saver exit must restore the selected material");
      await until(() => realSaver ? invoke("cyrene-hud", "state").powerPaused && invoke("cyrene-hud", "state").effectiveBackground === "clear" : invoke("cyrene-hud", "state").glassStatus === "ready");
      simulatedSaver = undefined;
      fixture.destroy();
      checks.push(`${realSaver ? "Real" : "Simulated"} battery saver uses transparent fallback with adjustable tint at 80% opacity in persistent/hover mode; settings explain it; simulated saver exit restores the selected material`);
      invoke("cyrene-hud", "save", { ...savedAppearance, background: "acrylic" });
    }
    assert.equal(invoke("cyrene-hud", "state").config.radius, 70);
  }
  invoke("cyrene-hud", "save", { ...savedAppearance, background: "solid" });
  await until(async () => await hud.webContents.executeJavaScript("document.body.dataset.background === 'solid' && getComputedStyle(document.querySelector('#hud')).borderTopLeftRadius === '70px'"));
  if (invoke("cyrene-hud", "state").materialSupported) {
    invoke("cyrene-hud", "save", { ...savedAppearance, background: "acrylic", mode: "hover" });
    invoke("cyrene-hud", "preview");
    await until(() => invoke("cyrene-hud", "state").glassStatus === "ready");
    assert.equal(hud.isVisible(), true, "Delayed glass startup interrupted preview");
    assert.equal(glassMessages.some(message => message.focused), false);
    checks.push("A fresh native helper can become ready during hover preview without hiding it or resetting its timer");
  }
  invoke("cyrene-hud", "save", { ...state.config, width: 340, height: 118, radius: 160, metric: "clock", mode: "persistent" });
  await until(async () => await hud.webContents.executeJavaScript("document.querySelector('#label').textContent === '本地时间'"));
  assert.equal(await hud.webContents.executeJavaScript("document.querySelector('#value').scrollWidth <= document.querySelector('#value').clientWidth"), true);
  for (const width of [340, 408]) for (const scale of [1, 1.2]) {
    let reference;
    for (const background of ["solid", "clear", "acrylic", "mica"]) {
      if (["acrylic", "mica"].includes(background) && !state.materialSupported) continue;
      invoke("cyrene-hud", "save", { ...state.config, width, scale, background, metric: "clock", mode: "persistent" });
      await until(async () => await hud.webContents.executeJavaScript(`document.body.dataset.background === '${background}'`));
      await sleep(350);
      const layout = await hud.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('#hud').getBoundingClientRect();
        return ['.mark', '.readout', '.ring'].map(selector => {
          const element = document.querySelector(selector), rect = element.getBoundingClientRect();
          return { visible: getComputedStyle(element).display !== 'none', x: rect.x - card.x, y: rect.y - card.y, width: rect.width, height: rect.height };
        });
      })()`);
      assert.equal(layout[0].visible, true, `${background}: avatar hidden at ${width}px / ${scale}`);
      if (!reference) reference = layout;
      for (let i = 0; i < layout.length; i++) for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Math.abs(layout[i][key] - reference[i][key]) < 1, `${background}: ${key} layout differs from solid`);
      }
      assert.equal(await hud.webContents.executeJavaScript("document.querySelector('#value').scrollWidth <= document.querySelector('#value').clientWidth"), true);
      if (width === 408 && scale === 1) fs.writeFileSync(path.join(__dirname, `hud-aligned-${background}.png`), (await hud.webContents.capturePage()).toPNG());
    }
  }
  checks.push("All four backgrounds keep the avatar and matching card-relative layout at 340/408px and 1/1.2 scale; clock fits");
  for (const height of [60, 118]) for (const background of ["solid", "clear", "acrylic", "mica"]) {
    if (["acrylic", "mica"].includes(background) && !state.materialSupported) continue;
    invoke("cyrene-hud", "save", { ...state.config, width: 340, height, background, metric: "memory", mode: "persistent" });
    await until(async () => await hud.webContents.executeJavaScript(`document.body.dataset.background === '${background}' && document.querySelector('#value').classList.contains('memory') && document.querySelector('#value').textContent.includes(' / ')`));
    await sleep(350);
    const memory = await hud.webContents.executeJavaScript(`(() => {
      const value = document.querySelector('#value'), card = document.querySelector('#hud').getBoundingClientRect();
      return { value: value.textContent, unit: document.querySelector('#unit').textContent, symbol: document.querySelector('#symbol').textContent,
        fits: value.scrollWidth <= value.clientWidth, height: card.height,
        contained: ['.mark', '.readout', '.ring'].every(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return r.top >= card.top && r.bottom <= card.bottom; }) };
    })()`);
    assert.match(memory.value, /^\d+(\.\d+)? \/ \d+(\.\d+)?$/);
    assert.equal(memory.unit, "GB"); assert.match(memory.symbol, /^\d+(\.\d+)?%$/);
    assert.ok(memory.fits && memory.contained, `${background}/${height}: memory content clipped`);
    assert.ok(Math.abs(memory.height - height) < 1);
    if (height === 60) fs.writeFileSync(path.join(__dirname, `hud-compact-memory-${background}.png`), (await hud.webContents.capturePage()).toPNG());
  }
  checks.push("60px and 118px memory layout fits at minimum width in all backgrounds; absolute usage is left and percent is inside the ring");
  invoke("cyrene-hud", "save", { ...state.config, background: "solid" });
  await until(() => glassChildren.every(child => child.exitCode !== null || child.signalCode !== null));
  checks.push("Native glass starts without activating, preserves arbitrary radius and tint, and exits on material change");
  checks.push("Appearance form persists independent size/radius/background; native material modes switch and preserve radius; narrow clock remains readable");

  if (preview) {
    clearTimeout(deadline); checks.push("Isolated interactive preview; close settings to exit"); writeResult(true);
    panel.once("closed", () => { void finish(); }); return;
  }
  invoke("cyrene-hud", "save", { ...state.config, mode: "hover" }); assert.equal(hud.isVisible(), false);
  invoke("cyrene-hud", "preview"); assert.equal(hud.isVisible(), true);
  await until(() => !hud.isVisible(), 8000); checks.push("Hover mode hides initially; preview shows without focus and retracts after timeout");

  invoke("cyrene-hud", "save", { ...state.config, metric: "memory", mode: "persistent" });
  failSnapshot = true;
  await until(async () => await hud.webContents.executeJavaScript("document.querySelector('#status').textContent === '采集失败' && document.querySelector('#value').textContent === '—'"));
  failSnapshot = false;
  await until(async () => await hud.webContents.executeJavaScript("document.querySelector('#status').textContent === '实时'"));
  checks.push("Injected snapshot failure clears stale numbers; automatic retry recovers without restarting HUD (synthetic fault)");
  if (invoke("cyrene-hud", "state").materialSupported) {
    invoke("cyrene-hud", "save", { ...invoke("cyrene-hud", "state").config, background: "acrylic" });
    await until(() => invoke("cyrene-hud", "state").glassStatus === "ready");
  }
  await manager.setEnabled("cyrene-hud", false);
  await until(() => glassChildren.every(child => child.exitCode !== null || child.signalCode !== null));
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.deepEqual(["display-added", "display-removed", "display-metrics-changed"].map(event => screen.listenerCount(event)), displayListeners);
  assert.equal([...channels].some(name => name.startsWith("plugin:cyrene-hud:")), false);
  checks.push("Disabling HUD destroys both windows, unregisters IPC and removes display listeners");
  await manager.setEnabled("cyrene-hud", true); assert.equal(invoke("cyrene-hud", "state").config.metric, "memory");
  const restored = await invoke("cyrene-hud", "snapshot"); assert.ok(restored.memoryTotalGb > 0);
  await manager.setEnabled("cyrene-hud", false);
  await until(() => glassChildren.every(child => child.exitCode !== null || child.signalCode !== null));
  assert.equal([...channels].some(name => name.startsWith("plugin:")), false);
  assert.equal(errors.length, 0, JSON.stringify(errors)); checks.push("Re-enable restores saved settings and a working collector; final stop removes all plugin IPC");
  await finish();
}).catch(async error => { errors.push(String(error.stack || error)); try { await manager?.stop(); } catch {} clearTimeout(deadline); writeResult(false, String(error)); app.exit(1); });
