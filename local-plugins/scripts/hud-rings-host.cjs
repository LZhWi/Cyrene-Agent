"use strict";
const { app, BrowserWindow, ipcMain, screen } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { PluginManager } = require("./host-api.cjs");
const edition = process.env.CYRENE_HUD_EDITION, checks = [], errors = [], children = [], commands = [], messages = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function inspectStack(fixture) {
  const handle = win => win.getNativeWindowHandle().readBigUInt64LE().toString();
  const script = `Add-Type @'
using System; using System.Runtime.InteropServices;
public class HudStack {
 [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$hud=[IntPtr]${handle(hud)}; $fixture=[IntPtr]${handle(fixture)}; $above=$false
$previous=[HudStack]::GetWindow($hud,3)
while ($previous -ne [IntPtr]::Zero) { if ($previous -eq $fixture) { $above=$true; break }; $previous=[HudStack]::GetWindow($previous,3) }
@{fixtureAbove=$above;topmost=(([HudStack]::GetWindowLongPtr($hud,-20).ToInt64() -band 8) -ne 0);hudFocused=([HudStack]::GetForegroundWindow() -eq $hud)}|ConvertTo-Json -Compress`;
  const { stdout } = await require("node:util").promisify(require("node:child_process").execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10000 });
  return JSON.parse(stdout);
}
async function until(test, timeout = 5000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await test()) return; await sleep(25); } throw Error("Condition timed out"); }
for (const name of ["userData", "sessionData", "logs"]) { fs.mkdirSync(path.join(__dirname, name), { recursive: true }); app.setPath(name, path.join(__dirname, name)); }
app.on("window-all-closed", () => {});
let point = { x: -10000, y: -10000 }, manager, hud, panel, snapshotCount = 0, statusCount = 0, enabled = {};
let sensorOverride = { cpuTemperature: 68, fans: [{ id: "cpu", rpm: 4200 }, { id: "gpu", rpm: 4400 }] };
global.__hudPerformanceFixture = async () => {
  snapshotCount++;
  return { capturedAt: Date.now(), cpuPercent: 37, cpuModel: "Test CPU", cpuFrequencyGhz: 3.2, memoryPercent: 82, memoryUsedGb: 25.7, memoryTotalGb: 31.4, gpuPercent: 54, gpuSource: "nvidia:0", gpuTemperature: 61, vramUsedGb: 4.2, vramTotalGb: 8, networkBytesPerSecond: 4194304, networkUploadBytesPerSecond: 1048576, networkDownloadBytesPerSecond: 3145728, batteryPercent: null, ...sensorOverride };
};
const proactiveMessages = [], notificationOpens = [];
let notificationOpenFails = false;
function openProactive(id) {
  assert.equal(id, "proactive-fixture");
  if (notificationOpenFails) throw Error("Isolated opening failure");
  notificationOpens.push(id); return true;
}
const expanded = id => { const item = state().layout.items.find(item => item.id === id); return state().layout.active === id && item.amount === item.fullWidth; };
const tools = require("node:child_process"), spawn = tools.spawn;
tools.spawn = function(file, args, options) {
  const child = spawn.call(this, file, args, options);
  if (file.endsWith("GlassHost.exe")) {
    children.push(child); let pending = "";
    const write = child.stdin.write;
    child.stdin.write = function(data, ...rest) { commands.push(String(data)); return write.call(this, data, ...rest); };
    child.stdout.on("data", chunk => { pending += chunk; let end; while ((end = pending.indexOf("\n")) >= 0) { try { messages.push(JSON.parse(pending.slice(0, end))); } catch {} pending = pending.slice(end + 1); } });
  }
  return child;
};
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _file, error) => errors.push(String(error)));
  contents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
});
const forbidden = () => { throw Error("Model or prompt service accessed"); };
const state = () => manager.invokePluginIpc("cyrene-hud", "state", []);
async function save(patch) { point = { x: -10000, y: -10000 }; await manager.invokePluginIpc("cyrene-hud", "save", [{ ...state().config, ...patch }]); await sleep(100); }
function hover(id, detail = false) {
  const f = state().layout, b = f.bounds, zoom = hud.webContents.getZoomFactor();
  const inset = ["acrylic", "mica"].includes(state().effectiveBackground) ? 0 : 16;
  const x = id === "avatar" ? detail ? f.avatarDetailX + f.avatarDetailWidth / 2 : f.avatarX + 22 : (() => { const item = f.items.find(item => item.id === id); return detail ? item.detailX + Math.min(50, item.fullWidth / 2) : item.ringX + f.ring / 2; })();
  point = { x: b.x + (x + inset) * zoom, y: b.y + (f.height / 2 + (inset ? 21 : 0)) * zoom };
}
async function shot(name) { const b = state().layout.bounds, canvas = hud.getBounds(); fs.writeFileSync(path.join(__dirname, name + ".png"), (await hud.webContents.capturePage({ x: b.x - canvas.x, y: b.y - canvas.y, width: b.width, height: b.height })).toPNG()); }
const deadline = setTimeout(() => { errors.push("deadline"); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  screen.getCursorScreenPoint = () => point;
  ipcMain.handle("chats:list", () => [{ id: "proactive-fixture", title: "主动消息", mode: "chat", purpose: "proactive-chat", updatedAt: proactiveMessages.at(-1)?.at || 0 }]);
  ipcMain.handle("chats:get-page", (_event, input) => {
    assert.equal(input.id, "proactive-fixture");
    const end = input.before ?? proactiveMessages.length, start = Math.max(0, end - input.limit);
    return { session: { purpose: "proactive-chat", messageCount: proactiveMessages.length }, messages: proactiveMessages.slice(start, end), hasMore: start > 0 };
  });
  ipcMain.handle("chats:open-in-react-window", (_event, id) => openProactive(id));
  ipcMain.handle("runtime-state:get", () => { statusCount++; return { status: "陪伴中", feeling: "开心", privateHistory: "must not leak" }; });
  ipcMain.handle("model-config:get", () => ({ connected: true, runtimeSync: "local", provider: "private", apiKey: "must not leak" }));
  const handlers = new Map();
  manager = new PluginManager({ scanRoots: [{ path: path.join(__dirname, "plugins"), source: "user" }], storageRoot: path.join(__dirname, "plugin-data"), loadEnabledMap: () => enabled, saveEnabledMap: value => { enabled = value; }, runtime: {
    toolRegistry: { register: forbidden, unregister: forbidden }, channelManager: { has: forbidden, register: forbidden, unregister: forbidden, startOne: forbidden },
    promptRegistry: { register: forbidden, unregister: forbidden, registerStable: forbidden, unregisterStable: forbidden },
    hostServices: { createForPlugin: () => edition === "upstream" ? {} : { windowNavigation: { listSessions: () => [], open: target => { assert.equal(target.target, "chat"); assert.equal(target.session, "existing"); return openProactive(target.sessionId); } } } },
    registerIpc: (channel, handler) => { handlers.set(channel, handler); ipcMain.handle(channel, (_event, ...args) => handler(...args)); },
    unregisterIpc: channel => { handlers.delete(channel); ipcMain.removeHandler(channel); }, invokeIpc: (channel, args) => handlers.get(channel)(...args),
  } });
  await manager.start();
  const installed = await manager.installZip(path.join(process.env.CYRENE_HUD_ARTIFACTS, `cyrene-hud-${edition}.zip`)); assert.equal(installed.ok, true, JSON.stringify(installed));
  fs.writeFileSync(path.join(__dirname, "plugins/cyrene-hud/collector.cjs"), 'module.exports = { createCollector: () => ({ snapshot: () => global.__hudPerformanceFixture(), dispose() {} }) };');
  const started = await manager.setEnabled("cyrene-hud", true); assert.equal(started.ok, true, JSON.stringify(started));
  hud = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith("/hud.html"));
  assert.equal(hud.isFocusable(), false); assert.deepEqual(state().config.metrics, ["memory", "cpu", "gpu"]); assert.equal("hideTrigger" in state().config, false);
  await sleep(500);
  assert.equal(hud.isVisible(), true); assert.equal(state().expanded, false);
  assert.ok(snapshotCount > 0); assert.equal(statusCount, 0);
  const collapsedReads = snapshotCount;
  await sleep(5100); assert.ok(snapshotCount > collapsedReads); assert.equal(state().expanded, false);
  assert.equal(state().layout.width, 48); assert.equal(state().layout.height, 10);
  await shot("resident-capsule");
  proactiveMessages.push({ id: "delivery-1", role: "model", at: Date.now(), content: "今天也辛苦了，要不要休息一下？" });
  hud.webContents.send("chats:changed");
  await until(() => state().notification.count === 1 && state().layout.noticeProgress === 1);
  assert.ok(snapshotCount > 0); assert.equal(state().expanded, false);
  await shot("proactive-toast");
  assert.equal(await hud.webContents.executeJavaScript("document.getElementById('notificationPreview').textContent"), "今天也辛苦了，要不要休息一下？");
  await sleep(1100); assert.equal(state().layout.noticeProgress, 1);
  await until(() => state().layout.noticeProgress === 0);
  assert.equal(await hud.webContents.executeJavaScript("document.getElementById('unreadSatellite')"), null);
  await shot("proactive-retracted");
  hud.webContents.send("chats:changed"); await sleep(300);
  assert.equal(state().notification.count, 1); assert.equal(state().layout.noticeProgress, 0);
  manager.invokePluginIpc("cyrene-hud", "preview", []);
  const trigger = screen.getPrimaryDisplay().workArea;
  point = { x: trigger.x + trigger.width / 2, y: trigger.y + 5 };
  await until(() => state().layout.revealProgress === 1);
  const badgeStyle = await hud.webContents.executeJavaScript("(()=>{const b=getComputedStyle(document.getElementById('unreadBadge'));return {background:b.backgroundColor,color:b.color,fill:b.webkitTextFillColor,stroke:b.webkitTextStrokeWidth,border:getComputedStyle(document.getElementById('hud')).borderTopColor}})()");
  assert.equal(badgeStyle.background, badgeStyle.color);
  assert.equal(badgeStyle.fill, "rgba(0, 0, 0, 0)");
  assert.equal(badgeStyle.stroke, "0.45px");
  assert.equal(badgeStyle.border, "rgba(0, 0, 0, 0)");
  assert.equal(await hud.webContents.executeJavaScript("document.getElementById('unreadBadge').textContent"), "1");
  await shot("proactive-avatar-badge");
  notificationOpenFails = true;
  await hud.webContents.executeJavaScript("document.getElementById('unreadBadge').click()");
  await until(async () => await hud.webContents.executeJavaScript("document.getElementById('status').textContent === '无法打开'"));
  assert.equal(state().notification.count, 1);
  notificationOpenFails = false;
  await hud.webContents.executeJavaScript("document.getElementById('unreadBadge').click()");
  await until(() => state().notification.count === 0);
  assert.deepEqual(notificationOpens, ["proactive-fixture"]);
  assert.equal(await hud.webContents.executeJavaScript("document.getElementById('unreadBadge').hidden"), true);
  point = { x: -10000, y: -10000 }; await save({ mode: "hover" });
  checks.push("Two-second toast retracts to a plain capsule without a satellite; HUD retains a solid unread circle with hollow digits and clears only after successful opening");
  const residentCanvas = hud.getBounds(), morph = [];
  const capsuleTop = await hud.webContents.executeJavaScript("document.getElementById('hud').getBoundingClientRect().top");
  const area = screen.getPrimaryDisplay().workArea;
  point = { x: area.x + area.width / 2, y: area.y + 5 };
  await sleep(200); assert.equal(state().expanded, false);
  point = { x: -10000, y: -10000 }; await sleep(100); assert.equal(state().expanded, false);
  point = { x: area.x + area.width / 2, y: area.y + 5 };
  await until(() => state().expanded);
  await until(() => state().layout.revealProgress > .2);
  assert.ok(state().layout.revealProgress < 1); await shot("capsule-morph-mid");
  while (state().layout.revealProgress !== 1) { morph.push(state().layout.revealProgress); assert.deepEqual(hud.getBounds(), residentCanvas); assert.equal(await hud.webContents.executeJavaScript("document.getElementById('hud').getBoundingClientRect().top"), capsuleTop); await sleep(16); }
  assert.equal(await hud.webContents.executeJavaScript("document.getElementById('hud').getBoundingClientRect().top"), capsuleTop);
  assert.ok(morph.length > 3); await shot("capsule-morph-expanded");
  assert.equal(await hud.webContents.executeJavaScript("document.getElementById('hudContent').inert"), false);
  point = { x: -10000, y: -10000 };
  checks.push("Resident 48x10 capsule keeps five-second main-process monitoring, requires continuous hover, and morphs through eased frames into HUD on a fixed native canvas");
  await save({ mode: "persistent", background: "solid", position: "bottom-center", opacity: 1 });
  await until(async () => (await hud.webContents.executeJavaScript("Array.from(document.querySelectorAll('.ring-label'), n => n.textContent)")).join() === "内存,CPU,GPU");
  await until(() => snapshotCount > 0); await shot("rings-collapsed");
  const expandedReads = snapshotCount;
  await sleep(2200); assert.ok(snapshotCount >= expandedReads + 2);
  checks.push("Expanded HUD receives fresh main-process performance snapshots every second; collapsed HUD continues monitoring without renderer polling");
  assert.equal(await hud.webContents.executeJavaScript("document.querySelector('#hud [title]') === null"), true);
  checks.push("Sandbox preload renders the chosen ordered rings with metric names and one shared snapshot; HUD is nonfocusable");
  const base = state().layout.bounds, before = state().layout.items[0].ringX;
  await hud.webContents.executeJavaScript(`window.revealFrames=[]; window.revealRecording=true; (function sample(){if(!window.revealRecording)return; const detail=document.querySelector('[data-metric=memory] .metric-detail'), text=detail.querySelector('strong'), rect=detail.getBoundingClientRect(), edge=parseFloat(detail.style.getPropertyValue('--reveal-edge')); window.revealFrames.push({width:rect.width,textWidth:text.getBoundingClientRect().width,text:text.textContent,edge,solid:parseFloat(detail.style.getPropertyValue('--reveal-solid')),nextLeft:document.querySelector('[data-metric=cpu] .ring').getBoundingClientRect().left,detailLeft:rect.left,mask:getComputedStyle(detail).maskImage,overflow:getComputedStyle(text).textOverflow,opacity:getComputedStyle(detail).opacity});requestAnimationFrame(sample)})()`);
  hover("memory"); await sleep(100); assert.equal(state().layout.active, null);
  await until(() => state().layout.width > 256); assert.ok(state().layout.width < 384);
  await until(() => state().layout.items[0].amount > state().layout.items[0].fullWidth * .35);
  await shot("rings-reveal-mid");
  await until(() => expanded("memory"));
  const revealFrames = await hud.webContents.executeJavaScript("window.revealRecording=false; window.revealFrames");
  const revealing = revealFrames.filter(frame => frame.edge > 16 && frame.edge < frame.width - 16);
  assert.ok(revealing.length >= 3);
  const fullTextWidth = revealFrames.at(-1).textWidth;
  for (const frame of revealing) {
    assert.equal(frame.width, revealFrames.at(-1).width); assert.equal(frame.textWidth, fullTextWidth);
    assert.equal(frame.text, "25.7 / 31.4 GB"); assert.equal(frame.overflow, "clip"); assert.equal(frame.opacity, "1");
    assert.ok(frame.mask.startsWith("linear-gradient")); assert.equal(frame.edge - frame.solid, 16);
    assert.ok(Math.abs(frame.nextLeft - frame.detailLeft - frame.edge - 12) <= 1);
  }
  fs.writeFileSync(path.join(__dirname, "detail-reveal-trace.json"), JSON.stringify(revealFrames, null, 2));
  assert.equal(state().layout.items[1].amount, 0); assert.equal(state().layout.items[2].amount, 0);
  assert.ok(Math.abs(state().layout.bounds.x + state().layout.items[0].ringX - base.x - before) <= 1);
  assert.equal(await hud.webContents.executeJavaScript("document.querySelector('[data-metric=memory] strong').textContent"), "25.7 / 31.4 GB");
  assert.deepEqual(await hud.webContents.executeJavaScript("({label:getComputedStyle(document.querySelector('[data-metric=memory] .ring-label')).opacity,value:getComputedStyle(document.querySelector('[data-metric=memory] .ring-value')).opacity,text:document.querySelector('[data-metric=memory] .ring-value').textContent,detail:document.querySelector('[data-metric=memory] small').textContent,clipped:(()=>{const n=document.querySelector('[data-metric=memory] strong');return n.scrollWidth>n.clientWidth})()})"), { label: "0", value: "1", text: "82%", detail: "内存", clipped: false });
  hover("memory", true); await sleep(300); assert.equal(state().layout.active, "memory"); await shot("rings-memory");
  assert.equal(await hud.webContents.executeJavaScript("document.querySelector('#hud [title]') === null"), true);
  checks.push("150 ms dwell expands memory through intermediate spring frames; full text stays fixed without ellipsis or global fade, a 16 px soft mask edge follows the next ring, detail area retains hover");
  hover("cpu"); await until(() => state().layout.active === "cpu");
  await until(() => { hover("cpu"); return state().layout.items[0].amount === 0 && expanded("cpu"); });
  assert.equal(state().layout.items[0].amount, 0); assert.ok(state().layout.items[1].amount < 112);
  assert.equal(await hud.webContents.executeJavaScript("document.querySelector('[data-metric=cpu] strong').textContent"), "3.20 GHz");
  assert.equal(await hud.webContents.executeJavaScript("document.querySelector('[data-metric=cpu] small').textContent"), "CPU · 68 °C");
  checks.push("Switching rings closes the old detail and opens only the newly hovered metric");
  point = { x: -10000, y: -10000 }; await sleep(100); assert.equal(state().layout.active, "cpu"); await until(() => state().layout.width === 256);
  assert.deepEqual(state().layout.bounds, base);
  hover("avatar"); await until(() => state().layout.avatarProgress > .35);
  const avatarReveal = await hud.webContents.executeJavaScript("(()=>{const n=document.querySelector('#avatarDetail');return {width:n.getBoundingClientRect().width,edge:parseFloat(n.style.getPropertyValue('--reveal-edge')),solid:parseFloat(n.style.getPropertyValue('--reveal-solid')),mask:getComputedStyle(n).maskImage,opacity:getComputedStyle(n).opacity}})()");
  assert.ok(avatarReveal.edge > 0 && avatarReveal.edge < avatarReveal.width);
  assert.ok(avatarReveal.edge - avatarReveal.solid > 0 && avatarReveal.edge - avatarReveal.solid <= 16);
  assert.ok(avatarReveal.mask.startsWith("linear-gradient")); assert.equal(avatarReveal.opacity, "1");
  await shot("rings-avatar-reveal-mid"); await until(() => state().layout.avatarProgress === 1);
  assert.equal(state().layout.width, 256); assert.equal(state().layout.bounds.width, base.width);
  const avatarView = await hud.webContents.executeJavaScript("(async () => ({status:document.querySelector('#runtimeStatus').textContent, feeling:document.querySelector('#runtimeFeeling').textContent, hidden:Array.from(document.querySelectorAll('.metric'), n => getComputedStyle(n).opacity), projected:Object.keys(await window.cyreneHud.status())}))()");
  assert.equal(avatarView.status, "陪伴中"); assert.equal(avatarView.feeling, "开心"); assert.equal(avatarView.hidden[0], "0"); assert.equal(avatarView.hidden[2], "1");
  assert.deepEqual(avatarView.projected.sort(), ["available", "connected", "enabled", "feeling", "status"]);
  hover("avatar", true); await sleep(300); assert.equal(state().layout.active, "avatar"); await shot("rings-avatar");
  checks.push("Avatar status and feeling use the same soft reveal mask with measured text width, no shell widening, preserve the nonoverlapping GPU ring and project no host configuration or private data");
  point = { x: -10000, y: -10000 }; await until(() => state().layout.avatarProgress === 0);
  await until(async () => await hud.webContents.executeJavaScript("Array.from(document.querySelectorAll('.metric'), n => getComputedStyle(n).opacity).every(n => n === '1')"));
  checks.push("Leaving for 200 ms restores avatar details and every ring");
  await manager.open("cyrene-hud");
  panel = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith("/settings.html"));
  await until(async () => await panel.webContents.executeJavaScript("document.querySelectorAll('#metricList input').length === 7"));
  const beforeDemoConfig = JSON.stringify(state().config), beforeDemoUnread = state().notification.count;
  const demoClick = action => panel.webContents.executeJavaScript(`document.querySelector('[data-test-action=${action}]').click()`);
  await demoClick("hover");
  await until(() => state().testing && state().layout.avatarProgress === 1);
  assert.equal(await hud.webContents.executeJavaScript("document.getElementById('runtimeFeeling').textContent"), "平静");
  const demoReads = [snapshotCount, statusCount];
  await panel.webContents.executeJavaScript("document.getElementById('testRegion').value='cpu'");
  await demoClick("hover"); await until(() => expanded("cpu"));
  await sleep(1100);
  assert.equal(await hud.webContents.executeJavaScript("document.querySelector('[data-metric=cpu] strong').textContent"), "3.80 GHz");
  assert.deepEqual([snapshotCount, statusCount], demoReads);
  await hud.webContents.executeJavaScript("window.cyreneHud.openTarget()");
  assert.deepEqual(notificationOpens, ["proactive-fixture"]);
  await demoClick("notification");
  await until(() => state().layout.noticeProgress === 1);
  await shot("ui-test-notification");
  assert.equal(state().notification.count, 1);
  await hud.webContents.executeJavaScript("window.cyreneHud.openNotification()");
  assert.deepEqual(notificationOpens, ["proactive-fixture"]);
  await until(() => state().layout.noticeProgress === 0);
  await demoClick("stop");
  await until(() => !state().testing);
  assert.equal(JSON.stringify(state().config), beforeDemoConfig);
  assert.equal(state().notification.count, beforeDemoUnread);
  await demoClick("hover"); await until(() => state().testing);
  panel.close(); await until(() => !state().testing);
  await manager.open("cyrene-hud");
  panel = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith("/settings.html"));
  await until(async () => await panel.webContents.executeJavaScript("document.querySelectorAll('#metricList input').length === 7"));
  checks.push("Settings UI simulates avatar/ring hover and notification animations using fixture data without hardware/status reads or navigation; stop and panel close restore real configuration and unread");
  assert.equal(await panel.webContents.executeJavaScript("document.getElementById('hideTrigger')"), null);
  assert.equal(await panel.webContents.executeJavaScript("document.getElementById('width')"), null);
  const configBeforeInfo = JSON.stringify(state().config);
  assert.deepEqual(await panel.webContents.executeJavaScript("({hidden:document.getElementById('displayNotes').hidden,display:getComputedStyle(document.getElementById('displayNotes')).display,expanded:document.getElementById('displayInfo').getAttribute('aria-expanded'),type:document.getElementById('displayInfo').type})"), { hidden: true, display: "none", expanded: "false", type: "button" });
  fs.writeFileSync(path.join(__dirname, "settings-notes-hidden.png"), (await panel.webContents.capturePage()).toPNG());
  await panel.webContents.executeJavaScript("document.getElementById('displayInfo').click()");
  const info = await panel.webContents.executeJavaScript("(()=>{const b=document.getElementById('displayInfo'),n=document.getElementById('displayNotes'),h=document.getElementById('display-heading'),br=b.getBoundingClientRect(),hr=h.getBoundingClientRect();return {hidden:n.hidden,expanded:b.getAttribute('aria-expanded'),paragraphs:n.querySelectorAll('p').length,text:n.textContent,right:br.left>hr.right,aligned:Math.abs(br.top+br.height/2-hr.top-hr.height/2)<1}})()");
  assert.equal(info.hidden, false); assert.equal(info.expanded, "true"); assert.equal(info.paragraphs, 5); assert.ok(info.text.includes("0.3 秒缓动")); assert.ok(info.right && info.aligned);
  await panel.webContents.executeJavaScript("document.getElementById('displayNotes').scrollIntoView({block:'nearest'})");
  await sleep(200);
  fs.writeFileSync(path.join(__dirname, "settings-notes-expanded.png"), (await panel.webContents.capturePage()).toPNG());
  await panel.webContents.executeJavaScript("document.getElementById('displayInfo').click()");
  assert.equal(await panel.webContents.executeJavaScript("document.getElementById('displayNotes').hidden && document.getElementById('displayInfo').getAttribute('aria-expanded') === 'false'"), true);
  assert.equal(JSON.stringify(state().config), configBeforeInfo);
  checks.push("Display instructions are hidden by default; a heading-right info button expands five annotation paragraphs and collapses them without saving or changing HUD settings");
  assert.deepEqual(await panel.webContents.executeJavaScript("Array.from(document.querySelector('#position').options).filter(option => !option.disabled).map(option => option.value)"), ["top-center"]);
  await panel.webContents.executeJavaScript("document.querySelector('[data-metric=cpu] button').click(); const b=document.querySelector('input[data-metric=battery]'); b.checked=true; b.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#form').requestSubmit()");
  await until(() => state().config.metrics.join() === "cpu,memory,gpu,battery"); panel.hide();
  checks.push("Settings choose multiple metrics, change their order and persist the result; countdown-condition UI is removed");
  const shape = [];
  for (const background of ["solid", "clear", "acrylic", "mica"]) {
    await save({ metrics: ["memory", "cpu", "gpu"], background, position: "bottom-right" });
    assert.equal(state().config.position, "top-center");
    if (background !== "solid" && state().materialSupported) await until(() => state().glassStatus === "ready");
    await sleep(400);
    shape.push(await hud.webContents.executeJavaScript("({avatar:document.querySelector('#avatarAction').getBoundingClientRect().width,rings:Array.from(document.querySelectorAll('.ring'),n=>({w:n.getBoundingClientRect().width,h:n.getBoundingClientRect().height}))})"));
    const resting = state().layout.bounds, oldRingX = state().layout.items[2].ringX;
    hover("gpu"); await until(() => expanded("gpu"));
    assert.ok(Math.abs(state().layout.bounds.x + state().layout.items[2].ringX - resting.x - oldRingX) <= 1);
    const area = screen.getPrimaryDisplay().workArea; assert.ok(state().layout.bounds.x + state().layout.bounds.width <= area.x + area.width);
    await shot(`rings-${background}-gpu`);
    assert.equal(await hud.webContents.executeJavaScript("document.querySelector('[data-metric=gpu] strong').scrollWidth > document.querySelector('[data-metric=gpu] strong').clientWidth"), false);
    if (background === "acrylic" && state().materialSupported) { assert.ok(commands.some(line => /^style 30 [0-9.]+ 60 acrylic/.test(line))); assert.ok(messages.some(message => message.ready && message.focused === false)); }
  }
  shape.forEach(value => assert.deepEqual(value, shape[0]));
  checks.push("All four background modes share avatar/ring dimensions; legacy positions load at top center and expansion stays inside work area; native glass receives the same card geometry and never focuses");
  await save({ metrics: ["memory", "cpu", "gpu", "network", "battery", "clock"], width: 340, background: "solid", backgroundColor: "#252525" });
  assert.ok(state().layout.width >= 436); await shot("rings-all-dark");
  assert.equal(await hud.webContents.executeJavaScript("document.body.classList.contains('dark-tint')"), true);
  hover("network"); await until(() => expanded("network"));
  assert.deepEqual(await hud.webContents.executeJavaScript("Array.from(document.querySelector('[data-metric=network] .metric-detail').children,n=>n.textContent)"), ["↑ 1.00 MB/s", "↓ 3.00 MB/s"]); await shot("rings-network");
  checks.push("All six metrics fit in the compact collapsed shell; dark palette and unsupported battery are handled");
  await save({ metrics: ["memory", "cpu", "gpu", "network", "battery", "clock", "fan"], background: "solid", cpuFanReferenceRpm: 6000, gpuFanReferenceRpm: 8000 });
  await until(async () => await hud.webContents.executeJavaScript("document.querySelectorAll('.metric').length === 7 && document.querySelector('[data-metric=fan] .inner-ring').hasAttribute('hidden') === false"));
  const palettes = [];
  const brightness = color => { const rgb = color.match(/[\d.]+/g).map(Number); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
  for (const [palette, backgroundColor, color] of [["gray", "#a5a5a5", "rgb(64, 59, 68)"], ["light", "#f7f7f7", "rgb(64, 59, 68)"], ["dark", "#252525", "rgb(246, 232, 238)"]]) {
    await save({ backgroundColor });
    await sleep(300);
    const target = await hud.webContents.executeJavaScript("({track:document.body.style.getPropertyValue('--hud-track'),ring:document.body.style.getPropertyValue('--hud-ring')})");
    const ringStyles = await hud.webContents.executeJavaScript("Array.from(document.querySelectorAll('.metric'),n=>({id:n.dataset.metric,progress:Array.from(n.querySelectorAll('.progress'),circle=>({color:getComputedStyle(circle).stroke,opacity:getComputedStyle(circle).opacity})),label:getComputedStyle(n.querySelector('.ring-label')).color,value:getComputedStyle(n.querySelector('.ring-value')).color,track:getComputedStyle(n.querySelector('.track')).stroke}))");
    for (const ring of ringStyles) {
      const labelColor = palette === "dark" ? ring.progress[0].color : "rgb(81, 73, 85)";
      assert.equal(ring.label, labelColor, `${palette} ${ring.id} label color`);
      assert.equal(ring.value, labelColor, `${palette} ${ring.id} value color`);
      if (["gpu", "fan"].includes(ring.id)) {
        assert.deepEqual(ring.progress[0], ring.progress[1]); assert.equal(ring.progress[0].opacity, "1");
        assert.equal(ring.track, target.track); assert.equal(ring.progress[0].color, target.ring);
      }
    }
    if (palette !== "dark") {
      const surface = parseInt(backgroundColor.slice(1, 3), 16);
      assert.ok(brightness(target.track) > 195 && brightness(target.track) < 236);
      assert.ok(brightness(target.ring) > 160 && brightness(target.ring) < 200);
      assert.ok(brightness(target.track) - brightness(target.ring) > 20);
      const channels = target.ring.match(/\d+/g).map(Number);
      assert.ok(channels[0] - channels[1] > 75 && channels[0] - channels[1] < 106);
      assert.ok(palette === "gray" ? brightness(target.track) > surface + 16 : brightness(target.track) < surface - 16);
    }
    palettes.push({ palette, backgroundColor, ...target });
    for (const id of ["gpu", "fan", "network"]) {
      const styles = await hud.webContents.executeJavaScript(`Array.from(document.querySelector('[data-metric=${id}] .metric-detail').children,n=>{const s=getComputedStyle(n);return {fontSize:s.fontSize,fontWeight:s.fontWeight,color:s.color,lineHeight:s.lineHeight,fontFamily:s.fontFamily,marginTop:s.marginTop}})`);
      assert.deepEqual(styles[0], styles[1], `${palette} ${id} detail typography`);
      assert.equal(styles[0].fontSize, "13px"); assert.equal(styles[0].fontWeight, "500"); assert.equal(styles[0].color, color); assert.equal(styles[0].marginTop, "0px");
      if (palette !== "dark" && id !== "gpu") {
        hover(id); await until(() => { hover(id); return expanded(id); }); await shot(`rings-${palette}-${id}-typography`);
      }
    }
  }
  assert.ok(brightness(palettes[1].ring) > brightness(palettes[0].ring));
  assert.deepEqual(palettes[2], { palette: "dark", backgroundColor: "#252525", track: "rgba(255, 192, 216, 0.22)", ring: "rgb(245, 211, 224)" });
  fs.writeFileSync(path.join(__dirname, "adaptive-palettes.json"), JSON.stringify(palettes, null, 2));
  assert.deepEqual(await hud.webContents.executeJavaScript("Array.from(document.querySelector('[data-metric=network] .network-rate').children,n=>getComputedStyle(n).fontSize)"), ["8px", "8px"]);
  assert.equal(await hud.webContents.executeJavaScript("document.querySelector('[data-metric=gpu] .inner-ring').hasAttribute('hidden')"), false);
  assert.deepEqual(await hud.webContents.executeJavaScript("Array.from(document.querySelectorAll('[data-metric=network] .network-rate'), n=>n.textContent)"), ["↑1.00", "↓3.00"]);
  assert.equal(await hud.webContents.executeJavaScript("document.querySelector('[data-metric=network] .upload').getBoundingClientRect().top < document.querySelector('[data-metric=network] .download').getBoundingClientRect().top"), true);
  await shot("rings-seven-collapsed");
  const sizing = [];
  for (const id of state().config.metrics) {
    hover(id); await until(() => { hover(id); return expanded(id) && state().layout.items.filter(item => item.id !== id).every(item => item.amount === 0); });
    const detail = await hud.webContents.executeJavaScript(`(()=>{const n=document.querySelector('[data-metric=${id}] .metric-detail'); const text=Array.from(n.children, child=>{const range=document.createRange();range.selectNodeContents(child);return range.getBoundingClientRect().width});return {width:n.getBoundingClientRect().width,textWidth:Math.max(...text),clipped:Array.from(n.children,child=>child.scrollWidth>child.clientWidth)}})()`);
    assert.ok(detail.width - detail.textWidth >= 11 && detail.width - detail.textWidth <= 18, JSON.stringify({ id, ...detail }));
    assert.equal(detail.clipped.some(Boolean), false, id);
    sizing.push({ id, ...detail });
    if (["cpu", "gpu", "network", "fan"].includes(id)) await shot(`rings-measured-${id}`);
  }
  assert.equal(await hud.webContents.executeJavaScript("document.querySelector('[data-metric=fan] .ring-value').textContent"), "70%");
  assert.ok(Math.abs(Number(await hud.webContents.executeJavaScript("document.querySelector('[data-metric=fan] .inner-ring .progress').getAttribute('stroke-dasharray').split(' ')[0]")) - 150.796 * .55) < .01);
  fs.writeFileSync(path.join(__dirname, "measured-details.json"), JSON.stringify(sizing, null, 2));
  sensorOverride = { cpuTemperature: null, fans: [{ id: "gpu", rpm: 2500 }], gpuSource: "wmi-engine-sum", vramUsedGb: null, vramTotalGb: null };
  await save({ metrics: ["gpu", "fan"] });
  await until(async () => await hud.webContents.executeJavaScript("document.querySelector('[data-metric=gpu] .inner-ring').hasAttribute('hidden') && document.querySelector('[data-metric=fan] .inner-ring').hasAttribute('hidden') && document.querySelector('[data-metric=fan]').getAttribute('aria-label').includes('2500')"));
  await shot("rings-single-fan");
  sensorOverride = { cpuTemperature: null, fans: [] };
  await save({ metrics: ["fan"] });
  await until(async () => await hud.webContents.executeJavaScript("document.querySelector('[data-metric=fan]').classList.contains('unavailable')"));
  sensorOverride = { cpuTemperature: 68, fans: [{ id: "cpu", rpm: 4200 }, { id: "gpu", rpm: 4400 }] };
  checks.push("All seven details fit measured text; GPU/fan/network rows match; light text is darker and tracks brighter on gray and near-white backdrops, dark palette and inner/outer ring colors are preserved; dedicated VRAM and fan fallback, stacked network rates and CPU temperature render");
  await save({ metrics: ["memory", "cpu", "gpu"], background: "solid", scale: 1.2 });
  hover("memory");
  const trace = [], canvas = hud.getBounds(), left = state().layout.bounds.x;
  const timer = setInterval(() => { const f = state().layout, b = hud.getBounds(); trace.push({ width: f.width, left: f.bounds.x, window: b, ringX: f.bounds.x + f.items[0].ringX * hud.webContents.getZoomFactor(), active: f.active }); }, 16);
  try { await until(() => expanded("memory")); await sleep(500); } finally { clearInterval(timer); }
  const expandedTrace = trace.filter(frame => frame.active === "memory");
  assert.ok(expandedTrace.length > 8); assert.equal(expandedTrace.every(frame => Math.abs((frame.width - 256) * 1.2 - Math.round((frame.width - 256) * 1.2)) < .001), true);
  assert.ok(Math.max(...expandedTrace.map(frame => frame.ringX)) - Math.min(...expandedTrace.map(frame => frame.ringX)) <= 1);
  trace.forEach(frame => { assert.deepEqual(frame.window, canvas); assert.equal(frame.left, left); });
  fs.writeFileSync(path.join(__dirname, "animation-trace.json"), JSON.stringify(trace));
  await shot("rings-scaled-memory");
  checks.push("120% zoom uses a fixed native canvas and left edge while the memory card expands; ring geometry stays on the pixel grid");
  const animations = [];
  for (const background of ["solid", "acrylic"]) {
    await save({ metrics: ["memory", "cpu", "gpu"], background, scale: 1.2 });
    if (background === "acrylic" && state().materialSupported) await until(() => state().glassStatus === "ready");
    await sleep(300);
    const fixed = hud.getBounds(), initial = state().layout.bounds, nativeStart = messages.length, commandStart = commands.length;
    const samples = [];
    let recording = true;
    const collect = (async () => {
      while (recording) {
        const f = state().layout, b = hud.getBounds();
        const dom = await hud.webContents.executeJavaScript("(()=>{const r=document.querySelector('#hud').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}})()");
        samples.push({ active: f.active, left: f.bounds.x, width: f.width, window: b, dom });
        await sleep(25);
      }
    })();
    try {
      hover("memory"); await until(() => state().layout.active === "memory"); await sleep(1200);
      point = { x: -10000, y: -10000 }; await until(() => state().layout.width === 256); await sleep(300);
    } finally { recording = false; await collect; }
    assert.ok(samples.some(sample => sample.width > 256 && sample.width < 384));
    samples.forEach(sample => { assert.deepEqual(sample.window, fixed); assert.equal(sample.left, initial.x); });
    const domLeft = samples.map(sample => sample.dom.left); assert.ok(Math.max(...domLeft) - Math.min(...domLeft) < .1);
    const updates = messages.slice(nativeStart).filter(message => message.synced && Number.isFinite(message.boundsUpdates)).map(message => message.boundsUpdates);
    if (background === "acrylic" && state().materialSupported && state().effectiveBackground === "acrylic") { assert.ok(updates.length > 8); assert.equal(new Set(updates).size, 1); }
    const sampling = messages.slice(nativeStart).filter(message => Number.isFinite(message.luminance));
    if (background === "acrylic" && state().materialSupported && state().effectiveBackground === "acrylic") {
      assert.ok(sampling.length >= 2);
      assert.equal(new Set(sampling.map(message => `${message.sampleLeft},${message.sampleTop},${message.sampleWidth}`)).size, 1);
      assert.equal(sampling[0].sampleWidth, Math.round(256 * 1.2 * screen.getPrimaryDisplay().scaleFactor));
      const styles = commands.slice(commandStart).filter(line => line.includes(" acrylic "));
      assert.ok(styles.length > 8);
      styles.forEach(line => assert.equal(Number(line.trim().split(" ")[9]), 256));
    }
    animations.push({ background, samples, nativeBoundsUpdates: updates, backdropSamples: sampling });
  }
  fs.writeFileSync(path.join(__dirname, "shell-animation-trace.json"), JSON.stringify(animations));
  checks.push("Expansion and collapse keep Electron and native blur window bounds fixed, and the rendered shell left edge does not move in solid and acrylic modes");
  checks.push("Native brightness sampling stays at the collapsed shell's fixed screen position and width throughout expansion and collapse; HUD has no native hover tooltips");
  const stacking = [];
  const b = hud.getBounds();
  const fixture = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, show: false, focusable: false, webPreferences: { sandbox: true } });
  try {
    await fixture.loadURL("data:text/html,<html><body>Isolated stacking target</body></html>");
    fixture.setAlwaysOnTop(true); fixture.showInactive();
    for (const background of ["solid", "acrylic"]) {
      await save({ background, mode: "persistent" });
      fixture.moveTop(); await sleep(1300);
      const recovery = await inspectStack(fixture);
      stacking.push({ background, phase: "recovery", ...recovery });
      assert.equal(recovery.fixtureAbove, false, JSON.stringify(recovery));
      assert.equal(recovery.topmost, true); assert.equal(recovery.hudFocused, false);
      hud.hide(); fixture.moveTop(); manager.invokePluginIpc("cyrene-hud", "preview", []);
      const revealed = await inspectStack(fixture);
      stacking.push({ background, phase: "reveal", ...revealed });
      assert.equal(revealed.fixtureAbove, false, JSON.stringify(revealed));
      assert.equal(revealed.topmost, true); assert.equal(revealed.hudFocused, false);
      hud.setAlwaysOnTop(false); await sleep(1300);
      const restored = await inspectStack(fixture);
      stacking.push({ background, phase: "restored", ...restored });
      assert.equal(restored.topmost, true); assert.equal(restored.fixtureAbove, false); assert.equal(restored.hudFocused, false);
    }
  } finally { fixture.destroy(); }
  fs.writeFileSync(path.join(__dirname, "window-stacking.json"), JSON.stringify(stacking, null, 2));
  checks.push("Reveal raises HUD without focusing, and visible HUD recovers from a covering topmost peer or lost topmost flag in solid and acrylic modes");
  await save({ metrics: ["clock"], mode: "hover", displayDuration: .3 });
  const count = snapshotCount; manager.invokePluginIpc("cyrene-hud", "preview", []);
  point = { x: area.x + area.width / 2, y: area.y + 5 }; await until(() => state().layout.revealProgress === 1);
  hover("avatar"); await sleep(700); assert.equal(hud.isVisible(), true); assert.equal(snapshotCount, count);
  point = { x: -10000, y: -10000 }; await until(() => !state().expanded && state().layout.revealProgress > .1);
  point = { x: area.x + area.width / 2, y: area.y + 5 }; await until(() => state().expanded && state().layout.revealProgress === 1);
  point = { x: -10000, y: -10000 }; await until(() => state().layout.revealProgress === 0);
  const hiddenStatusCount = statusCount; await sleep(1100); assert.equal(statusCount, hiddenStatusCount);
  assert.equal(hud.isVisible(), true); assert.ok(Math.abs(state().layout.width - 48) <= .5 / hud.webContents.getZoomFactor()); assert.equal(state().layout.height, 10); assert.equal(state().layout.avatarProgress, 0);
  assert.equal(await hud.webContents.executeJavaScript("document.getElementById('hudContent').inert"), true);
  await shot("capsule-retracted");
  checks.push("Clock-only HUD reverses retraction on return, shrinks only after leaving both regions, remains a visible capsule and stops reads while retracted");
  await manager.setEnabled("cyrene-hud", false); assert.equal([...handlers.keys()].filter(channel => channel.startsWith("plugin:cyrene-hud:")).length, 0); await manager.setEnabled("cyrene-hud", true); assert.deepEqual(state().config.metrics, ["clock"]); await manager.setEnabled("cyrene-hud", false);
  await until(() => children.every(child => child.exitCode !== null || child.signalCode !== null));
  checks.push("Disable removes all plugin handlers, timers, windows and native children; re-enable preserves selected metrics");
  assert.equal(errors.length, 0, JSON.stringify(errors));
}).catch(error => errors.push(String(error.stack || error))).finally(async () => {
  if (hud && !hud.isDestroyed() && hud.isVisible()) { try { await shot("final"); } catch {} }
  await manager?.stop(); for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy(); clearTimeout(deadline);
  fs.writeFileSync(path.join(__dirname, "native-commands.json"), JSON.stringify(commands, null, 2));
  fs.writeFileSync(path.join(__dirname, "result.json"), JSON.stringify({ ok: errors.length === 0, edition, checks, errors, simulatedCursor: true, realHardwareDataUsed: false, modelServicesUsed: false, realUserDataUsed: false, globalMouseInputSent: false, nativeFramesSent: commands.length, localFullAppVerified: false, upstreamFullAppVerified: false }, null, 2)); app.exit(errors.length ? 1 : 0);
});
