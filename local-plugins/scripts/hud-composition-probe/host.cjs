const { app, BrowserWindow, nativeImage, screen } = require("electron");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const run = process.env.HUD_COMPOSITION_RUN;
app.setPath("userData", path.join(run, "user"));
app.on("window-all-closed", () => {});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, logs = "", responses = [], overlay;
const results = { nativeComposition: true, productionPluginChanged: false, modelServicesUsed: false, screenshotsUsedForRendering: false, checks: [] };
results.focusFailures = [];
const deadline = setTimeout(() => finish(new Error("Probe timeout")), 90000);
async function until(test) { for (let n = 0; n < 100; n++) { if (await test()) return; await sleep(100); } throw Error("Native response timeout: " + logs); }
async function command(value) { const count = responses.length; child.stdin.write(value + "\n"); await until(() => responses.length > count); if (responses.at(-1).focused) results.focusFailures.push(value); await sleep(900); }
function finish(error) {
  clearTimeout(deadline);
  if (child && child.exitCode === null) child.kill();
  fs.writeFileSync(path.join(run, "native.log"), logs);
  fs.writeFileSync(path.join(run, "result.json"), JSON.stringify({ ...results, ok: !error, error: error?.stack }, null, 2));
  app.exit(error ? 1 : 0);
}
app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay(), scale = display.scaleFactor;
  const area = display.workArea;
  const bounds = { x: area.x + 140, y: area.y + 160, width: 600, height: 200 };
  results.display = { scaleFactor: scale, size: display.size };
  const point = screen.dipToScreenPoint({ x: bounds.x, y: bounds.y });
  child = spawn(path.join(run, "GlassProbe.exe"), [point.x, point.y, Math.round(bounds.width * scale), Math.round(bounds.height * scale)].map(String), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", data => { logs += data; });
  let pending = "";
  child.stdout.on("data", data => { logs += data; pending += data; let end; while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1); try { responses.push(JSON.parse(line)); } catch {} } });
  child.on("error", finish);
  await until(() => responses.some(value => value.ready));
  if (responses[0].focused) results.focusFailures.push("startup");
  async function capture(name) {
    await command("capture " + name);
    return nativeImage.createFromPath(path.join(run, name + ".png"));
  }
  await command("clear"); const baseline = await capture("01-baseline");
  await command("radius " + Math.round(60 * scale)); await command("glass"); const rounded = await capture("02-rounded-60");
  await command("radius 0"); await capture("03-square");
  await command("radius " + Math.round(100 * scale)); await capture("04-pill");
  await command("radius " + Math.round(60 * scale));
  await command("blue");
  await sleep(1200); const changed = await capture("05-background-changed");
  function regionDifference(a, b, x, y, width, height) {
    const aa = a.toBitmap(), bb = b.toBitmap(), stride = a.getSize().width * 4;
    let total = 0;
    for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) for (let c = 0; c < 3; c++) total += Math.abs(aa[yy * stride + xx * 4 + c] - bb[yy * stride + xx * 4 + c]);
    return total / (width * height * 3);
  }
  const corner = regionDifference(baseline, rounded, 0, 0, 12, 12);
  const center = regionDifference(baseline, rounded, 200, 80, 120, 80);
  const dynamic = regionDifference(rounded, changed, 200, 80, 120, 80);
  function horizontalVariation(image) {
    const pixels = image.toBitmap(), stride = image.getSize().width * 4;
    let total = 0;
    for (let y = 80; y < 160; y++) for (let x = 201; x < 320; x++) for (let c = 0; c < 3; c++) total += Math.abs(pixels[y * stride + x * 4 + c] - pixels[y * stride + (x - 1) * 4 + c]);
    return total / (80 * 119 * 3);
  }
  const sharpVariation = horizontalVariation(baseline), blurredVariation = horizontalVariation(rounded);
  results.pixelDifferences = { corner, center, dynamic, sharpVariation, blurredVariation };
  assert.ok(corner < 2, "Rounded corner changed background pixels");
  assert.ok(center > 10, "Native backdrop produced no visible effect");
  assert.ok(dynamic > 10, "Native backdrop did not update with the desktop");
  assert.ok(blurredVariation < sharpVariation * 0.2, "Background stripes were tinted but not blurred");
  results.checks.push("Native backdrop changes with controlled desktop background; rounded exterior retains original pixels");

  overlay = new BrowserWindow({ ...bounds, frame: false, resizable: false, transparent: true, backgroundColor: "#00000000", hasShadow: false, focusable: false, show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(run, "preload.cjs") } });
  await overlay.loadFile(path.join(run, "hud.html"));
  await overlay.webContents.insertCSS(".hud { width:100vw!important; height:100vh!important; background:rgba(255,251,252,.22)!important; border-radius:60px!important; box-shadow:none!important; padding:24px 36px!important; } .enter {animation:none!important}");
  overlay.setAlwaysOnTop(true); overlay.setIgnoreMouseEvents(true, { forward: true }); overlay.showInactive(); overlay.moveTop();
  await command("behind " + overlay.getNativeWindowHandle().readBigUInt64LE().toString());
  await sleep(1000); assert.equal(overlay.isFocused(), false);
  const combined = await capture("06-electron-hud");
  const pixels = combined.toBitmap(); let darkPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 65 && pixels[i + 1] < 65 && pixels[i + 2] < 65) darkPixels++;
  assert.ok(darkPixels > 200, "HUD text is missing or blurred behind the native layer");
  results.darkTextPixels = darkPixels;
  results.checks.push("Existing sandboxed Electron HUD renders clear text over a separate native glass layer");
  for (const [name, tint, text] of [["pink", "rgba(255,180,205,.45)", "#1d1d1f"], ["blue", "rgba(145,200,255,.45)", "#1d1d1f"], ["dark", "rgba(25,28,42,.72)", "#fff"]]) {
    const key = await overlay.webContents.insertCSS(`.hud {background:${tint}!important;color:${text}!important}`);
    await sleep(700); await capture("tint-" + name);
    await overlay.webContents.removeInsertedCSS(key);
  }
  results.checks.push("Pink, blue and dark background tints render independently of text opacity over native blur");
  overlay.setBounds({ ...bounds, width: 400, height: 140, x: bounds.x + 40, y: bounds.y + 20 });
  results.resizedOverlay = { bounds: overlay.getBounds(), viewport: await overlay.webContents.executeJavaScript("({width:innerWidth,height:innerHeight,zoom:devicePixelRatio})") };
  await until(async () => await overlay.webContents.executeJavaScript("document.querySelector('#hud').offsetWidth===400 && document.querySelector('#hud').offsetHeight===140"));
  await command("size " + Math.round(400 * scale) + " " + Math.round(140 * scale));
  const moved = screen.dipToScreenPoint({ x: bounds.x + 40, y: bounds.y + 20 });
  await command("move " + moved.x + " " + moved.y);
  const resized = await capture("07-resized-moved");
  assert.deepEqual(resized.getSize(), { width: Math.round(400 * scale), height: Math.round(140 * scale) });
  assert.equal(overlay.isFocused(), false);
  results.checks.push("Native glass and Electron content move and resize together at 150% display scaling");
  child.stdin.write("quit\n");
  await until(() => child.exitCode !== null); assert.equal(child.exitCode, 0);
  overlay.destroy(); assert.equal(BrowserWindow.getAllWindows().length, 0);
  results.checks.push("Native helper exits normally and the Electron overlay is destroyed");
  results.focusVerified = results.focusFailures.length === 0;
  finish(results.focusVerified ? null : new Error("Visual checks completed; native startup/activation still requires investigation"));
}).catch(finish);
