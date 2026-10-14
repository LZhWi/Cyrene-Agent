// Requires user-authorized ViGEmBus installation. Initialization primes one
// analog unit then verifies zero; no gameplay pulse or game launch.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "artifacts/dungeons-input/runtime/DungeonsInput.exe");
const run = path.join(root, ".test-runtime", `dungeons-input-devices-${Date.now()}`);
await mkdir(run, { recursive: true });
const exec = promisify(execFile), checks = [], sessions = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = async argument => JSON.parse((await exec(executable, [argument], { windowsHide: true, timeout: 10000 })).stdout.replace(/^\uFEFF/, "").trim());
const state = () => invoke("--xinput-status");
async function removed(slots) {
  for (let n = 0; n < 40; n++) { const current = await state(); if (slots.every(index => !current.slots[index].connected)) return; await sleep(50); }
  throw Error("Owned virtual targets remained connected");
}
async function session() {
  const child = spawn(executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); sessions.add(child);
  const closed = new Promise(resolve => child.once("close", code => { sessions.delete(child); resolve(code); }));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Ready deadline")), 10000); let buffer = "";
    child.stdout.setEncoding("utf8"); child.stdout.on("data", data => {
      buffer += data; let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end).replace(/^\uFEFF/, "")); buffer = buffer.slice(end + 1);
        if (message.type === "state" && message.ready) { clearTimeout(timer); resolve(message); }
        if (message.type === "error") { clearTimeout(timer); reject(Error(message.error)); }
      }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
  child.stdin.on("error", () => {});
  assert.equal(ready.pads.length, 2); assert.notEqual(ready.pads[0], ready.pads[1]);
  const exposed = await state(); for (const index of ready.xinputSlots) assert.deepEqual(exposed.slots[index], { index, connected: true, neutral: true });
  return { child, closed, slots: ready.xinputSlots };
}
try {
  const probe = await invoke("--probe"); assert.equal(probe.available, true);
  checks.push("Actual native client connects to installed ViGEmBus");
  const baseline = await state();
  const native = await invoke("--device-test"); assert.equal(native.ok, true); assert.equal(native.gameplayPulseSent, false); assert.equal(native.initializationAnalogUnits, 1); checks.push(...native.checks);
  for (const mode of ["stop", "heartbeat", "pipe-close", "kill"]) {
    const owned = await session();
    if (mode === "stop") owned.child.stdin.write('{"type":"stop"}\n');
    if (mode === "pipe-close") owned.child.stdin.end();
    if (mode === "kill") owned.child.kill();
    let timeout;
    try { await Promise.race([owned.closed, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error(`${mode} exit deadline`)), 8000); })]); }
    finally { clearTimeout(timeout); }
    await removed(owned.slots); checks.push(`Actual two neutral targets disappear after ${mode}`);
  }
  assert.deepEqual((await state()).slots.map(slot => slot.connected), baseline.slots.map(slot => slot.connected));
  checks.push("XInput connected slots return to baseline; no unrelated device removed");
  const report = { ok: true, checks, baseline, initializationAnalogUnits: 1, gameplayPulseSent: false, gameLaunched: false, realGameCoopVerified: false };
  await writeFile(path.join(run, "result.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(path.join(run, "result.json"), JSON.stringify({ ok: false, checks, error: String(error) }, null, 2)); throw error;
} finally {
  for (const child of sessions) child.kill();
  console.log(`Report: ${run}`);
}
