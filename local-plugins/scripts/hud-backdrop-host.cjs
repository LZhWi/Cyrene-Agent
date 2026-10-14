"use strict";
const { app, BrowserWindow, nativeImage, screen } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn, execFile } = require("node:child_process"), { promisify } = require("node:util");
const run = process.env.CYRENE_BACKDROP_RUN;
for (const name of ["userData", "sessionData", "logs"]) { fs.mkdirSync(path.join(run, name), { recursive: true }); app.setPath(name, path.join(run, name)); }
app.on("window-all-closed", () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = [], reports = [];
let fixture, owner;
const handle = win => win.getNativeWindowHandle().readBigUInt64LE().toString();
async function capture(name) {
  const { stdout } = await promisify(execFile)(path.join(run, "Capture.exe"), [handle(owner), path.join(run, name + ".png")], { windowsHide: true, timeout: 10000 });
  return { image: nativeImage.createFromPath(path.join(run, name + ".png")), foreground: stdout.trim() };
}
function variation(image) {
  const { width, height } = image.getSize(), pixels = image.toBitmap(); let total = 0, count = 0;
  for (let y = Math.floor(height * .35); y < height * .65; y++) for (let x = Math.floor(width * .35); x < width * .65; x++) for (let c = 0; c < 3; c++) {
    total += Math.abs(pixels[(y * width + x) * 4 + c] - pixels[(y * width + x - 1) * 4 + c]); count++;
  }
  return total / count;
}
function foregroundPixels(image) {
  const pixels = image.toBitmap(); let count = 0;
  // Native bitmap channel order and desktop color conversion can vary. In
  // the neutral striped fixture, only HUD glyphs have saturated red/blue.
  for (let i = 0; i < pixels.length; i += 4) {
    const high = Math.max(pixels[i], pixels[i + 2]), low = Math.min(pixels[i], pixels[i + 2]);
    if (high > 160 && low < high * .45 && pixels[i + 1] < high * .45) count++;
  }
  return count;
}
function difference(a, b, corner = false) {
  const { width, height } = a.getSize(), aa = a.toBitmap(), bb = b.toBitmap(); let total = 0, count = 0;
  const x0 = corner ? 0 : Math.floor(width * .35), x1 = corner ? 8 : Math.floor(width * .65);
  const y0 = corner ? 0 : Math.floor(height * .35), y1 = corner ? 8 : Math.floor(height * .65);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) { total += Math.abs(aa[(y * width + x) * 4 + c] - bb[(y * width + x) * 4 + c]); count++; }
  return total / count;
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve)); child.stdin.write("quit\n");
  await Promise.race([exited, sleep(2000).then(() => child.kill())]);
}
const deadline = setTimeout(() => finish(Error("Backdrop test timeout")), 60000);
function finish(error) {
  clearTimeout(deadline); for (const child of children) if (child.exitCode === null) child.kill();
  for (const win of [owner, fixture]) if (win && !win.isDestroyed()) win.destroy();
  fs.writeFileSync(path.join(run, "result.json"), JSON.stringify({ ok: !error, reports, error: error?.stack, controlledChromiumWindow: true, screenshotsUsedForRendering: false, modelServicesUsed: false, realUserDataUsed: false }, null, 2)); app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  const area = screen.getPrimaryDisplay().workArea, bounds = { x: area.x + 160, y: area.y + 180, width: 600, height: 180 };
  fixture = new BrowserWindow({ x: bounds.x - 40, y: bounds.y - 40, width: 680, height: 260, frame: false, show: false, hasShadow: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await fixture.loadURL("data:text/html," + encodeURIComponent('<style>body{margin:0;height:100vh;background:repeating-linear-gradient(90deg,#101010 0 12px,#efefef 12px 24px)}body.blue{background:repeating-linear-gradient(90deg,#145aeb 0 12px,#dcf5ff 12px 24px)}</style>'));
  fixture.setAlwaysOnTop(true); fixture.showInactive(); fixture.moveTop();
  owner = new BrowserWindow({ ...bounds, frame: false, transparent: true, backgroundColor: "#00000000", show: false, focusable: false, hasShadow: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await owner.loadURL("data:text/html," + encodeURIComponent('<style>html,body{background:transparent;margin:0}b{position:absolute;left:60px;top:70px;color:#ff0000;background:white;font:24px sans-serif}</style><b>HUD</b>'));
  owner.setAlwaysOnTop(true); owner.setIgnoreMouseEvents(true); owner.showInactive(); owner.moveTop(); await sleep(500);
  for (const topmost of [true, false]) for (const mode of JSON.parse(process.env.CYRENE_BACKDROP_MODES)) {
    const name = mode + (topmost ? "-topmost" : "-ordinary");
    fixture.setAlwaysOnTop(topmost); fixture.focus(); owner.moveTop();
    await fixture.webContents.executeJavaScript("document.body.className=''"); await sleep(300);
    const baseline = await capture(name + "-baseline");
    assert.ok(variation(baseline.image) > 5, "Striped application fixture is not visible");
    const child = spawn(path.join(run, mode + ".exe"), [handle(owner)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
    let log = "", ready = false, messages = [], pending = "";
    child.stderr.on("data", data => log += data);
    child.stdout.on("data", data => { pending += data; let end; while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); try { const message = JSON.parse(line); messages.push(message); if (message.ready) ready = true; } catch {} } });
    for (let n = 0; !ready && n < 100 && child.exitCode === null; n++) await sleep(25);
    assert.ok(ready, log); child.stdin.write("style 60 600 180 acrylic 0 0 600 1 600\n"); await sleep(800);
    const blurred = await capture(name);
    let stability;
    if (mode !== "before") {
      // A 60 DIP card straddles the horizontal title-bar/content boundary.
      await fixture.webContents.executeJavaScript("document.body.style.background='linear-gradient(to bottom,#272727 0 70px,#171717 70px 100%)'");
      await owner.webContents.executeJavaScript("(()=>{const tint=document.createElement('div');tint.id='tint';tint.style.cssText='position:absolute;left:0;top:0;width:600px;height:60px;border-radius:30px;background:rgba(249,244,248,.2)';document.body.append(tint)})()");
      child.stdin.write("style 30 600 60 acrylic 0 0 600 1 600\n");
      await sleep(400);
      const reference = await capture(name + "-steady");
      const scale = reference.image.getSize().width / 600, crop = { x: 0, y: 0, width: Math.round(600 * scale), height: Math.round(60 * scale) };
      let samples;
      try {
        await promisify(execFile)(path.join(run, "Capture.exe"), [handle(owner), path.join(run, name + "-burst"), "90"], { windowsHide: true, timeout: 10000 });
        samples = Array.from({ length: 90 }, (_, index) => difference(reference.image.crop(crop), nativeImage.createFromPath(path.join(run, name + "-burst-" + index + ".png")).crop(crop)));
        for (let cycle = 0; cycle < 3; cycle++) for (const reverse of [true, false]) for (let step = 0; step <= 20; step++) {
          const amount = reverse ? 1 - step / 20 : step / 20, width = 48 + 552 * amount, height = 10 + 50 * amount;
          child.stdin.write(`style ${height / 2} ${width} ${height} acrylic ${(600 - width) / 2} ${(60 - height) / 2} 600 1 ${width}\n`);
          await owner.webContents.executeJavaScript(`document.getElementById('tint').style.cssText='position:absolute;left:${(600 - width) / 2}px;top:${(60 - height) / 2}px;width:${width}px;height:${height}px;border-radius:${height / 2}px;background:rgba(249,244,248,.2)'`);
          await sleep(16);
        }
        await sleep(400);
        const after = await capture(name + "-after-morph");
        stability = { background: "horizontal split", topGray: "#272727", bottomGray: "#171717", boundaryInHud: 30, hudHeight: 60, frames: samples.length, maximumDifference: Math.max(...samples), morphCycles: 3, afterMorphDifference: difference(reference.image.crop(crop), after.image.crop(crop)) };
      } finally {
        await fixture.webContents.executeJavaScript("document.body.style.background=''");
        await owner.webContents.executeJavaScript("document.getElementById('tint').remove()");
        child.stdin.write("style 60 600 180 acrylic 0 0 600 1 600\n");
      }
      fs.writeFileSync(path.join(run, name + "-stability.json"), JSON.stringify(stability));
      assert.ok(stability.maximumDifference < 2, "Static dark application background flickers");
      assert.ok(stability.afterMorphDifference < 2, "Horizontal split background changes after a morph cycle");
    }
    await fixture.webContents.executeJavaScript("document.body.className='blue'"); await sleep(800); const changed = await capture(name + "-changed");
    const foregroundBefore = foregroundPixels(baseline.image), foregroundAfter = foregroundPixels(blurred.image);
    const foregroundWindows = [baseline.foreground, blurred.foreground, changed.foreground];
    const nativeWindows = [handle(owner), ...messages.filter(message => message.handle).map(message => message.handle)];
    const focusNotStolen = foregroundWindows.every(window => !nativeWindows.includes(window)) && !messages.some(message => message.focused);
    const result = { mode, topmost, stability, sharpVariation: variation(baseline.image), blurredVariation: variation(blurred.image), cornerDifference: difference(baseline.image, blurred.image, true), dynamicDifference: difference(blurred.image, changed.image), foregroundBefore, foregroundAfter, foregroundSharp: foregroundBefore > 20 && foregroundAfter >= foregroundBefore * .9 && foregroundAfter <= foregroundBefore * 1.1, focusUnchanged: baseline.foreground === blurred.foreground && baseline.foreground === changed.foreground, focusNotStolen, foregroundWindows, log, messages };
    if (mode !== "before") {
      await fixture.webContents.executeJavaScript("document.body.className=''");
      child.stdin.write("style 5 48 10 acrylic 276 4 600 1 48\n"); await sleep(500);
      const capsule = await capture(name + "-capsule"), scale = capsule.image.getSize().width / 600;
      const crop = { x: Math.round(276 * scale), y: Math.round(4 * scale), width: Math.round(48 * scale), height: Math.round(10 * scale) };
      result.capsule = { sharpVariation: variation(baseline.image.crop(crop)), blurredVariation: variation(capsule.image.crop(crop)), outsideDifference: difference(baseline.image, capsule.image) };
      assert.ok(result.capsule.sharpVariation > 5);
      assert.ok(result.capsule.blurredVariation < result.capsule.sharpVariation * .2, "Small capsule does not blur");
      assert.ok(result.capsule.outsideDifference < 2, "Old large blur persists outside the capsule");
    }
    reports.push(result); await stop(child);
    if (mode !== "before") {
      assert.ok(result.blurredVariation < result.sharpVariation * .2, "Other application's pixels remain sharp");
      assert.ok(result.cornerDifference < 2, "Blur leaks outside rounded corners");
      assert.ok(result.dynamicDifference > 10, "Application content did not update under blur");
      assert.ok(result.focusNotStolen, "Blur stole focus");
      assert.ok(result.foregroundSharp, "HUD foreground was obscured or blurred");
    } else {
      assert.ok(result.blurredVariation >= result.sharpVariation * .9, "Old topmost-window bug was not reproduced");
    }
  }
  finish();
}).catch(finish);
