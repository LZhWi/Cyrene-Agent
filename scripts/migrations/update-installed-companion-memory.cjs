const { randomUUID } = require("node:crypto");
const { cpSync, existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "../..");
const containerRoot = path.resolve(projectRoot, "..");
if (path.basename(projectRoot) !== ".upstream-latest" || path.basename(containerRoot) !== "Cyrene-Agent-N") {
  throw new Error("只允许更新 Cyrene-Agent-N 中已安装的 companion-memory 插件");
}

async function main() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-Process -Name electron -ErrorAction SilentlyContinue | Select-Object Id,Path) | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0 || result.stderr.trim()) throw new Error("无法确认 -N 已退出");
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : [];
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  if (processes.some((item) => typeof item?.Path === "string"
    && path.resolve(item.Path).toLowerCase().includes(containerRoot.toLowerCase()))) {
    throw new Error("-N 仍在运行");
  }

  const pluginRoot = path.join(containerRoot, "AppData", "Roaming", "live2d-cyrene-n", "plugins");
  const installed = path.join(pluginRoot, "companion-memory");
  const artifact = path.join(projectRoot, "local-plugins", "artifacts", "companion-memory.zip");
  if (!existsSync(installed) || !existsSync(artifact)) throw new Error("已安装插件或构建产物不存在");
  const backupRoot = path.join(containerRoot, "PluginPackageBackups", `companion-memory-${randomUUID()}`);
  mkdirSync(backupRoot, { recursive: true });
  cpSync(installed, path.join(backupRoot, "companion-memory"), {
    recursive: true, force: false, errorOnExist: true, preserveTimestamps: true,
  });
  const { preparePluginZip, commitPreparedPlugin, discardPreparedPlugin } = require(path.join(projectRoot, "dist", "main", "plugins", "installer.js"));
  const prepared = await preparePluginZip(artifact, pluginRoot);
  try { await commitPreparedPlugin(prepared, pluginRoot, true); }
  catch (error) { await discardPreparedPlugin(prepared); throw error; }
  console.log(JSON.stringify({ ok: true, pluginId: "companion-memory", backupRoot }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
