// Read-only input fixtures; never captures the desktop or creates a controller.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [camp, menu] = process.argv.slice(2);
if (!camp || !menu) throw Error("Pass the provided camp and hero-selection PNG paths");
const run = path.join(root, ".test-runtime", `dungeons-follow-vision-${Date.now()}`);
await mkdir(run, { recursive: true });
const literal = value => `'${value.replaceAll("'", "''")}'`;
execFileSync("powershell.exe", ["-NoProfile", "-Command", `
Add-Type -AssemblyName System.Drawing
$taskSource = [System.Drawing.Bitmap]::new(${literal(path.resolve(camp))})
foreach($taskWidth in @(640,1280,1920)) {
  $taskScaled = [System.Drawing.Bitmap]::new($taskWidth,[int]($taskSource.Height*$taskWidth/$taskSource.Width),[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $taskGraphics = [System.Drawing.Graphics]::FromImage($taskScaled)
  $taskGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $taskGraphics.DrawImage($taskSource,0,0,$taskScaled.Width,$taskScaled.Height)
  $taskGraphics.Dispose()
  $taskScaled.Save((Join-Path ${literal(run)} "camp-$taskWidth.png"),[System.Drawing.Imaging.ImageFormat]::Png)
  $taskScaled.Dispose()
}
$taskDuplicate = [System.Drawing.Bitmap]::new($taskSource.Width,$taskSource.Height,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$taskGraphics = [System.Drawing.Graphics]::FromImage($taskDuplicate)
$taskGraphics.DrawImage($taskSource,0,0,$taskSource.Width,$taskSource.Height)
$taskGraphics.DrawImage($taskSource,[System.Drawing.Rectangle]::new(1700,1000,60,50),935,742,60,50,[System.Drawing.GraphicsUnit]::Pixel)
$taskGraphics.Dispose()
$taskDuplicate.Save((Join-Path ${literal(run)} 'duplicate.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$taskDuplicate.Dispose()
$taskSource.Dispose()
`], { windowsHide: true, stdio: "pipe" });
const executable = path.join(root, "artifacts/dungeons-input/runtime/DungeonsInput.exe");
const inspect = image => JSON.parse(execFileSync(executable, ["--vision-file", image], { windowsHide: true, encoding: "utf8" }));
const full = inspect(path.resolve(camp)), scaled = inspect(path.join(run, "camp-1280.png"));
for (const [frame, scale] of [[full, 1], [scaled, .5]]) {
  assert.equal(frame.Valid, true, frame.error);
  // Independently read locations of the two labels in the supplied screenshot.
  assert.ok(frame.p1.x > 1560 * scale && frame.p1.x < 1610 * scale);
  assert.ok(frame.p1.y > 735 * scale && frame.p1.y < 775 * scale);
  assert.ok(frame.p2.x > 943 * scale && frame.p2.x < 990 * scale);
  assert.ok(frame.p2.y > 748 * scale && frame.p2.y < 778 * scale);
}
const duplicate = inspect(path.join(run, "duplicate.png")); assert.equal(duplicate.Valid, false); assert.match(duplicate.error, /1 \/ 2/);
const selection = inspect(path.resolve(menu)); assert.equal(selection.Valid, false);
const small = inspect(path.join(run, "camp-640.png")), intermediate = inspect(path.join(run, "camp-1920.png"));
assert.equal(small.Valid, false); assert.equal(intermediate.Valid, false);
await writeFile(path.join(run, "preview.json"), JSON.stringify({ ...scaled, png: (await readFile(path.join(run, "camp-1280.png"))).toString("base64") }));
await writeFile(path.join(run, "result.json"), JSON.stringify({ ok: true, nativeDriverUsed: false, gameInputSent: false, desktopCaptured: false, full, scaled, duplicate, selection, rejectedScales: [small.width, intermediate.width], checks: 15 }, null, 2));
console.log(JSON.stringify({ ok: true, checks: 15, report: run, scaledP1: scaled.p1, scaledP2: scaled.p2, gameInputSent: false }, null, 2));
