"use strict";
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { execFile } = require("node:child_process"), { promisify } = require("node:util");
const { PluginManager, createPluginWindowNavigationService } = require("./host-api.cjs");
const edition = process.env.CYRENE_HUD_EDITION, modes = ["chat", "work", "code", "learn"];
const localIpc = process.env.CYRENE_HUD_LOCAL_IPC === "1", splitHost = edition === "local" || localIpc;
const nativePointer = process.env.CYRENE_HUD_NATIVE_POINTER === "1";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, timeout = 3000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await test()) return; await sleep(50); } throw Error("Condition timed out"); }
for (const name of ["userData", "sessionData", "logs"]) { fs.mkdirSync(path.join(__dirname, name), { recursive: true }); app.setPath(name, path.join(__dirname, name)); }
app.on("window-all-closed", () => {});
const checks = [], errors = [], opened = [], windows = new Map(), handlers = new Map(), ignored = new Map();
let manager, panel, hud, fixture, enabled = {}, serial = 0, created = 0, pointerVerified = false;
let savedCursor, globalMouseMovesSent = false, globalMouseClicksSent = false;
const rows = modes.map(mode => ({ id: mode, title: `${mode} existing`, mode, messages: ["Private history must not be returned"] }));
rows[0].purpose = "proactive-chat";
const forbidden = () => { throw Error("Model/tool/prompt service accessed"); };
const store = {
  listSessions: ({ mode } = {}) => rows.filter(row => !mode || row.mode === mode),
  getSession: id => rows.find(row => row.id === id) || null,
  createSession: ({ mode, title }) => { const row = { id: `new-${++serial}`, title: title || "新对话", mode, messages: [] }; rows.push(row); created++; return row; },
};
const originalIgnore = BrowserWindow.prototype.setIgnoreMouseEvents;
BrowserWindow.prototype.setIgnoreMouseEvents = function(value, options) { ignored.set(this.id, value); return originalIgnore.call(this, value, options); };
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _file, error) => errors.push(String(error)));
  contents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
});
async function openSession(id, kind) {
  const row = rows.find(row => row.id === id); assert.ok(row);
  let win = windows.get(kind);
  if (!win || win.isDestroyed()) {
    win = new BrowserWindow({ width: 420, height: 260, show: false, webPreferences: { sandbox: true } }); windows.set(kind, win);
    await win.loadURL("data:text/html,<html><body>Isolated navigation target</body></html>");
  }
  if (win.isMinimized()) win.restore(); win.show(); win.focus();
  opened.push({ id, mode: row.mode, kind });
  return win;
}
const windowManager = {
  openReactChatWindow: id => openSession(id, splitHost ? "chat" : "unified"),
  openReactWorkspaceWindow: id => openSession(id, "workspace"),
  createSettingsWindow: () => { opened.push({ kind: "settings", id: null }); },
  openSettings: async () => { opened.push({ kind: "settings", id: null }); },
};
async function pointer(point, action = "read", requiredHit = null) {
  const position = screen.dipToScreenPoint(point || screen.getCursorScreenPoint());
  if (action !== "read") globalMouseMovesSent = true;
  if (action === "click") globalMouseClicksSent = true;
  const command = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class HudPointer {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
}
'@
[HudPointer]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$p=New-Object HudPointer+Point; $p.x=${position.x}; $p.y=${position.y}
${action !== "read" ? "$mx=[uint32][Math]::Round(($p.x-[HudPointer]::GetSystemMetrics(76))*65535/([HudPointer]::GetSystemMetrics(78)-1)); $my=[uint32][Math]::Round(($p.y-[HudPointer]::GetSystemMetrics(77))*65535/([HudPointer]::GetSystemMetrics(79)-1)); [HudPointer]::mouse_event(49153,$mx,$my,0,[UIntPtr]::Zero)" : ""}
${action === "click" ? `if ([HudPointer]::GetAncestor([HudPointer]::WindowFromPoint($p),2).ToInt64().ToString() -ne '${requiredHit}') { throw 'Avatar is not the native hit target; click cancelled' }; [HudPointer]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [HudPointer]::mouse_event(4,0,0,0,[UIntPtr]::Zero)` : ""}
@{x=$p.x;y=$p.y;foreground=[HudPointer]::GetForegroundWindow().ToInt64().ToString();hit=[HudPointer]::GetAncestor([HudPointer]::WindowFromPoint($p),2).ToInt64().ToString()}|ConvertTo-Json -Compress`;
  const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 10000 });
  return JSON.parse(stdout);
}
async function save(patch) {
  const current = await hud.webContents.executeJavaScript("window.cyreneHud.state()");
  await hud.webContents.executeJavaScript(`window.cyreneHud.save(${JSON.stringify({ ...current.config, ...patch })})`);
  await until(async () => await hud.webContents.executeJavaScript("!document.querySelector('#avatarAction').disabled"));
}
async function click() {
  const count = opened.length;
  await hud.webContents.executeJavaScript("document.querySelector('#avatarAction').click()");
  await until(() => opened.length > count);
  for (const win of windows.values()) win.hide();
  return opened.at(-1);
}
const deadline = setTimeout(() => { errors.push("deadline"); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  if (!nativePointer) screen.getCursorScreenPoint = () => ({ x: -10000, y: -10000 });
  ipcMain.handle("runtime-state:get", () => ({ status: "陪伴中", feeling: "平静" }));
  ipcMain.handle("model-config:get", () => ({ runtimeSync: "off", connected: false }));
  if (nativePointer) savedCursor = screen.getCursorScreenPoint();
  if (edition === "upstream") {
    const Ajv = require("ajv"), schema = JSON.parse(fs.readFileSync(path.join(__dirname, "upstream-manifest.schema.json"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(process.env.CYRENE_HUD_ARTIFACTS, "cyrene-hud-upstream/manifest.json"), "utf8"));
    const validate = new Ajv({ strict: false }).compile(schema); assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
    require("./upstream-handlers.cjs").register(ipcMain, store, { windowManager }, () => undefined, () => {});
    checks.push(`Compatibility ZIP passes the ${localIpc ? "local" : "pinned upstream"} manifest schema and uses four actual ${localIpc ? "local" : "upstream"} IPC callbacks with an isolated in-memory session store`);
  }
  manager = new PluginManager({ scanRoots: [{ path: path.join(__dirname, "plugins"), source: "user" }], storageRoot: path.join(__dirname, "plugin-data"), loadEnabledMap: () => enabled, saveEnabledMap: value => { enabled = value; }, runtime: {
    toolRegistry: { register: forbidden, unregister: forbidden },
    channelManager: { has: forbidden, register: forbidden, unregister: forbidden, startOne: forbidden },
    promptRegistry: { register: forbidden, unregister: forbidden, registerStable: forbidden, unregisterStable: forbidden },
    hostServices: { createForPlugin: ({ signal }) => edition === "upstream" ? {} : { windowNavigation: createPluginWindowNavigationService({ signal, listSessions: () => rows, createSession: mode => store.createSession({ mode }), windows: windowManager }) } },
    registerIpc: (channel, handler) => { handlers.set(channel, handler); ipcMain.handle(channel, (_event, ...args) => handler(...args)); },
    unregisterIpc: channel => { handlers.delete(channel); ipcMain.removeHandler(channel); },
    invokeIpc: (channel, args) => handlers.get(channel)(...args),
  } });
  await manager.start();
  const installed = await manager.installZip(path.join(process.env.CYRENE_HUD_ARTIFACTS, `cyrene-hud-${edition}.zip`)); assert.equal(installed.ok, true, installed.error);
  assert.equal(manager.isRunning("cyrene-hud"), false);
  assert.equal((await manager.setEnabled("cyrene-hud", true)).ok, true);
  hud = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith("/hud.html"));
  assert.equal(hud.isFocusable(), false); assert.equal(ignored.get(hud.id), true);
  const bridgeState = await hud.webContents.executeJavaScript("window.cyreneHud.state()");
  assert.equal(bridgeState.edition, edition); assert.equal(bridgeState.config.avatarTarget, "none");
  await hud.webContents.executeJavaScript("window.cyreneHud.openTarget()"); assert.equal(opened.length, 0); assert.equal(created, 0);
  assert.equal(await hud.webContents.executeJavaScript("typeof require"), "undefined");
  checks.push("ZIP imports disabled, no-action is the default, renderer stays sandboxed and model/tool/prompt access is forbidden");
  await manager.open("cyrene-hud");
  panel = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith("/settings.html"));
  await until(async () => await panel.webContents.executeJavaScript("document.querySelector('#avatarTarget').value === 'none'"));
  assert.match(await panel.webContents.executeJavaScript("document.querySelector('#editionNote').textContent"), edition === "upstream" ? /按宿主规则/ : /Chat 在聊天窗口/);
  for (const mode of modes) {
    const sessions = await panel.webContents.executeJavaScript(`window.cyreneHud.listSessions('${mode}')`);
    assert.deepEqual(sessions, [{ id: mode, title: `${mode} existing`, mode }]);
    await panel.webContents.executeJavaScript(`document.querySelector('#avatarTarget').value='${mode}'; document.querySelector('#avatarSession').value='existing'; document.querySelector('#avatarTarget').dispatchEvent(new Event('input'));`);
    await until(async () => await panel.webContents.executeJavaScript(`Array.from(document.querySelector('#avatarSessionId').options).some(option => option.value === '${mode}')`));
    await panel.webContents.executeJavaScript(`document.querySelector('#avatarSessionId').value='${mode}'; document.querySelector('#form').requestSubmit()`);
    await until(() => JSON.parse(fs.readFileSync(path.join(__dirname, "plugin-data/cyrene-hud/settings.json"), "utf8")).avatarSessionId === mode);
    await save({ metric: "clock", metrics: ["clock"], background: "solid", mode: "persistent" });
    const existing = await click(); assert.equal(existing.id, mode);
    assert.equal(existing.kind, splitHost ? mode === "chat" ? "chat" : "workspace" : "unified");
    const oldCreated = created;
    await save({ avatarSession: "new" });
    await hud.webContents.executeJavaScript("Promise.all([window.cyreneHud.openTarget(), window.cyreneHud.openTarget()])");
    assert.equal(created, oldCreated + 1); assert.equal(opened.at(-1).mode, mode);
    assert.deepEqual(rows.at(-1).messages, []);
    for (const win of windows.values()) win.hide();
  }
  checks.push("Native settings select existing sessions in all four modes, metadata contains no history, and each mode opens the correct host window");
  checks.push("Existing proactive Chat is selectable and opens normally; its purpose does not hide it or expose its history");
  checks.push("Each new-session action creates an empty session in the requested mode; concurrent clicks merge into one creation");
  await save({ avatarTarget: "settings" }); assert.equal((await click()).kind, "settings");
  await save({ avatarTarget: "chat", avatarSession: "existing", avatarSessionId: "deleted" });
  const before = created, count = opened.length;
  const error = await hud.webContents.executeJavaScript("window.cyreneHud.openTarget().then(() => '', error => error.message)"); assert.match(error, /所选会话/);
  assert.equal(created, before); assert.equal(opened.length, count);
  await hud.webContents.executeJavaScript("document.querySelector('#avatarAction').click()");
  await until(async () => await hud.webContents.executeJavaScript("document.querySelector('#status').textContent === '无法打开'"));
  checks.push("Settings target uses no conversation; deleted sessions show an error without creating replacements");
  await save({ avatarTarget: "chat", avatarSession: "existing", avatarSessionId: "chat", position: "bottom-right", scale: 1.2, clickThrough: true });
  const b = hud.getBounds();
  fixture = new BrowserWindow({ x: b.x - 15, y: b.y - 15, width: b.width + 30, height: b.height + 30, show: false, webPreferences: { sandbox: true } });
  await fixture.loadURL("data:text/html,<html><body style='background:%23808080'>Isolated pointer target</body></html>");
  panel.hide(); if (nativePointer) { fixture.show(); fixture.focus(); } else fixture.showInactive(); fixture.moveTop(); hud.moveTop(); await sleep(400);
  const rect = await hud.webContents.executeJavaScript("(() => { const r=document.querySelector('#avatarAction').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()");
  const zoom = hud.webContents.getZoomFactor(), center = { x: Math.round(b.x + (rect.x + rect.width / 2) * zoom), y: Math.round(b.y + (rect.y + rect.height / 2) * zoom) };
  const input = { x: Math.round((rect.x + rect.width / 2) * zoom), y: Math.round((rect.y + rect.height / 2) * zoom), button: "left", clickCount: 1 };
  if (nativePointer) {
    await pointer({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }, "move");
    await pointer(center, "move");
  } else hud.webContents.sendInputEvent({ type: "mouseMove", x: input.x, y: input.y });
  await until(() => ignored.get(hud.id) === false, 2000);
  assert.equal((await pointer(center)).hit, hud.getNativeWindowHandle().readBigUInt64LE().toString());
  const clickCount = opened.length;
  if (nativePointer) await pointer(center, "click", hud.getNativeWindowHandle().readBigUInt64LE().toString());
  else { hud.webContents.sendInputEvent({ ...input, type: "mouseDown" }); hud.webContents.sendInputEvent({ ...input, type: "mouseUp" }); }
  await until(() => opened.length > clickCount); assert.equal(opened.at(-1).id, "chat");
  for (const win of windows.values()) win.hide();
  hud.moveTop();
  if (nativePointer) await pointer({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }, "move");
  else hud.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(b.width / 2), y: Math.round(b.height / 2) });
  await until(() => ignored.get(hud.id) === true, 2000);
  assert.notEqual((await pointer({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) })).hit, hud.getNativeWindowHandle().readBigUInt64LE().toString()); pointerVerified = true;
  fs.writeFileSync(path.join(__dirname, "hud-avatar.png"), (await hud.webContents.capturePage()).toPNG());
  checks.push(`${nativePointer ? "Actual Windows pointer and click" : "Injected renderer mouse events"} make the avatar interactive at 120% scale; Win32 hit tests confirm avatar targeting and passthrough elsewhere; click opens the configured session`);
  await manager.setEnabled("cyrene-hud", false); assert.equal([...handlers.keys()].filter(channel => channel.startsWith("plugin:cyrene-hud:")).length, 0);
  await manager.setEnabled("cyrene-hud", true);
  assert.equal(manager.invokePluginIpc("cyrene-hud", "state", []).config.avatarSessionId, "chat");
  await manager.setEnabled("cyrene-hud", false); assert.equal([...handlers.keys()].filter(channel => channel.startsWith("plugin:cyrene-hud:")).length, 0);
  checks.push("Re-enable preserves avatar target and session settings; disabling removes every plugin IPC handler");
  assert.equal(errors.length, 0, JSON.stringify(errors));
}).catch(async error => {
  errors.push(String(error.stack || error));
  if (hud && !hud.isDestroyed()) {
    fs.writeFileSync(path.join(__dirname, "failed-hud.png"), (await hud.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(__dirname, "failed-state.json"), JSON.stringify({ pointer: await pointer(), bounds: hud.getBounds(), zoom: hud.webContents.getZoomFactor(), ignored: ignored.get(hud.id), dom: await hud.webContents.executeJavaScript("({rect:document.querySelector('#avatarAction').getBoundingClientRect().toJSON(),disabled:document.querySelector('#avatarAction').disabled,hover:document.querySelector('#avatarAction').matches(':hover')})") }, null, 2));
  }
}).finally(async () => {
  try { await manager?.stop(); } catch (error) { errors.push(String(error)); }
  if (savedCursor) { try { await pointer(savedCursor, "move"); } catch (error) { errors.push(String(error)); } }
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  clearTimeout(deadline);
  fs.writeFileSync(path.join(__dirname, "result.json"), JSON.stringify({ ok: errors.length === 0, edition, hostFlavor: splitHost ? "local" : "upstream", checks, errors, opened, created, modelServicesUsed: false, realUserDataUsed: false, injectedMouseAndNativeHitTestsVerified: !nativePointer && pointerVerified, actualNativePointerHoverVerified: nativePointer && pointerVerified, globalMouseMovesSent, globalMouseClicksSent, localFullAppVerified: false, upstreamFullAppVerified: false, upstreamSourceCommit: edition === "upstream" && !localIpc ? "9fcff7a3b5106af6a6c60e35a94cfe95630463af" : null }, null, 2));
  app.exit(errors.length ? 1 : 0);
});
