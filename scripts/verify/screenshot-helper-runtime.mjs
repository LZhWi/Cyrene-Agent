import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const helperPath = path.resolve(process.argv[2] || path.join(
  repoRoot, "native", "cyrene-screenshot", "target", "release", "cyrene-screenshot.exe",
));
const runtimeRoot = path.join(repoRoot, ".runtime", `screenshot-helper-${crypto.randomUUID()}`);
const outputDir = path.join(runtimeRoot, "screenshots");
fs.mkdirSync(outputDir, { recursive: true });

let ready = false;
let stdout = "";
let stderr = "";
let settled = false;

try {
  const child = spawn(helperPath, [
    "--output-dir", outputDir,
    "--protocol-version", "1",
    "--parent-pid", String(process.pid),
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("截图 helper 协议握手超时"));
    }, 10_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "ready" && event.protocolVersion === 1 && !ready) {
          ready = true;
          child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (!ready || code !== 0) reject(new Error(`截图 helper 退出异常：ready=${ready} code=${code} ${stderr}`));
      else resolve({ ready: true, protocolVersion: 1, exitCode: code });
    });
  });
  settled = true;
  console.log(JSON.stringify(result));
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  const parent = path.dirname(runtimeRoot);
  if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  if (!settled) process.exitCode = 1;
}
