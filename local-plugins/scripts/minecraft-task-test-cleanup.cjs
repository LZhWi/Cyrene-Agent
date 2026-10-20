"use strict";
const fs = require("node:fs");
const exited = (child) => !child?.pid || child.exitCode !== null || child.signalCode != null;
function waitForExit(child, timeoutMs) {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (result) => { clearTimeout(timer); child.removeListener("exit", onExit); resolve(result); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(exited(child)), timeoutMs);
    child.once("exit", onExit);
  });
}
async function stopServer(server, { gracefulMs = 20000, termMs = 5000, killMs = 5000 } = {}) {
  if (exited(server)) return;
  // EPIPE after an early server exit must not crash the process or skip cleanup.
  server.stdin?.on("error", () => {});
  let waiting = waitForExit(server, gracefulMs);
  try { if (server.stdin?.writable && !server.stdin.destroyed) server.stdin.write("stop\n", () => {}); } catch {}
  if (await waiting) return;
  waiting = waitForExit(server, termMs);
  try { server.kill("SIGTERM"); } catch {}
  if (await waiting) return;
  waiting = waitForExit(server, killMs);
  try { server.kill("SIGKILL"); } catch {}
  if (!(await waiting)) throw new Error("Test server exit was not confirmed after SIGKILL");
}
async function cleanup({ manager, controller, server, temporary, remove = fs.rmSync, timing }) {
  const errors = [];
  // Each resource gets its own attempt even when a previous close rejects.
  for (const operation of [() => manager?.close(), () => controller?.close(), () => stopServer(server, timing), () => remove(temporary, { recursive: true, force: true })]) {
    try { await operation(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Live-test cleanup did not finish successfully");
}
module.exports = { cleanup, stopServer };
