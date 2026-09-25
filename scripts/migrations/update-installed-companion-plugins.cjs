const { randomUUID } = require("node:crypto");
const { cpSync, existsSync, mkdirSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..", "..");
const containerRoot = path.resolve(projectRoot, "..");
if (path.basename(projectRoot) !== ".upstream-latest" || path.basename(containerRoot) !== "Cyrene-Agent-N") {
  throw new Error("只允许更新 Cyrene-Agent-N 中已安装的陪伴插件");
}

function assertNoCyreneN() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-Process -Name electron -ErrorAction SilentlyContinue | Select-Object Id,Path) | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0 || result.stderr.trim()) throw new Error("无法确认 Cyrene-Agent-N 已退出");
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : [];
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const active = processes.filter((item) => typeof item?.Path === "string"
    && path.resolve(item.Path).toLowerCase().includes(path.resolve(containerRoot).toLowerCase()));
  if (active.length) throw new Error(`Cyrene-Agent-N 仍在运行: ${active.map((item) => item.Id).join(",")}`);
}

async function main() {
  assertNoCyreneN();
  const pluginRoot = path.join(containerRoot, "AppData", "Roaming", "live2d-cyrene-n", "plugins");
  const artifactRoot = path.join(projectRoot, "local-plugins", "artifacts");
  const pluginIds = ["companion-chat", "companion-memory"];
  for (const id of pluginIds) {
    if (!existsSync(path.join(pluginRoot, id))) throw new Error(`已安装插件不存在: ${id}`);
    if (!existsSync(path.join(artifactRoot, `${id}.zip`))) throw new Error(`构建产物不存在: ${id}.zip`);
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const backupRoot = path.join(containerRoot, "PluginPackageBackups", runId);
  mkdirSync(backupRoot, { recursive: true });
  for (const id of pluginIds) {
    cpSync(path.join(pluginRoot, id), path.join(backupRoot, id), {
      recursive: true, force: false, errorOnExist: true, preserveTimestamps: true,
    });
  }

  const { preparePluginZip, commitPreparedPlugin, discardPreparedPlugin } = require(path.join(projectRoot, "dist", "main", "plugins", "installer.js"));
  const prepared = [];
  try {
    for (const id of pluginIds) prepared.push(await preparePluginZip(path.join(artifactRoot, `${id}.zip`), pluginRoot));
    for (const item of prepared) await commitPreparedPlugin(item, pluginRoot, true);
  } catch (error) {
    for (const item of prepared) {
      try { await discardPreparedPlugin(item); } catch { /* 已提交的暂存目录可能已清理。 */ }
    }
    throw error;
  }
  console.log(JSON.stringify({ ok: true, runId, pluginIds, backupRoot }, null, 2));
}

main().catch((error) => {
  console.error(`[update-installed-companion-plugins] ${error?.stack || error}`);
  process.exitCode = 1;
});
