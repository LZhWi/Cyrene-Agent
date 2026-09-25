const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync, mkdirSync, existsSync, linkSync, unlinkSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..", "..");
const containerRoot = path.resolve(projectRoot, "..");
if (path.basename(projectRoot) !== ".upstream-latest" || path.basename(containerRoot) !== "Cyrene-Agent-N") {
  throw new Error("只允许向 Cyrene-Agent-N 导入本地图谱");
}

const source = path.join(process.env.APPDATA || "", "live2d-cyrene", "entity-graph.json");
const target = path.join(containerRoot, "AppData", "Roaming", "live2d-cyrene-n", "plugin-data", "companion-memory", "entity-graph.json");
if (!path.isAbsolute(source) || !source.toLowerCase().endsWith("\\live2d-cyrene\\entity-graph.json")) {
  throw new Error("无法确认本地图谱来源");
}
if (existsSync(target)) throw new Error("-N 图谱已存在，拒绝覆盖");

const processResult = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "@(Get-Process -Name electron -ErrorAction SilentlyContinue | Select-Object Id,Path) | ConvertTo-Json -Compress"],
{ encoding: "utf8", windowsHide: true, timeout: 10_000 });
if (processResult.error || processResult.status !== 0 || processResult.stderr.trim()) {
  throw new Error("无法确认 Cyrene-Agent-N 已退出");
}
const listed = processResult.stdout.trim() ? JSON.parse(processResult.stdout.trim()) : [];
const processes = Array.isArray(listed) ? listed : [listed];
if (processes.some((item) => typeof item?.Path === "string"
  && path.resolve(item.Path).toLowerCase().includes(containerRoot.toLowerCase()))) {
  throw new Error("Cyrene-Agent-N 仍在运行，拒绝修改其图谱");
}

const sourceBytes = readFileSync(source);
const local = JSON.parse(sourceBytes.toString("utf8"));
if (!Array.isArray(local.entities) || local.entities.length > 20_000
  || !Array.isArray(local.relations) || local.relations.length !== 0) {
  throw new Error("本地图谱结构不符，或存在 -N 当前无法保留的关系边");
}
const types = new Set(["person", "place", "concept", "preference", "organization"]);
const ids = new Set();
for (const entity of local.entities) {
  if (typeof entity?.id !== "string" || !entity.id || ids.has(entity.id)
    || typeof entity.name !== "string" || !entity.name || !types.has(entity.type)
    || !Array.isArray(entity.aliases) || entity.aliases.some((alias) => typeof alias !== "string" || !alias)
    || !Number.isSafeInteger(entity.mentionCount) || entity.mentionCount < 1
    || !Number.isFinite(entity.firstMentionedAt) || !Number.isFinite(entity.lastMentionedAt)) {
    throw new Error("本地图谱实体结构不符，拒绝导入");
  }
  ids.add(entity.id);
}

const imported = JSON.stringify({ version: 1, entities: local.entities });
mkdirSync(path.dirname(target), { recursive: true });
const temporary = `${target}.${process.pid}.tmp`;
try {
  writeFileSync(temporary, imported, { encoding: "utf8", flag: "wx" });
  linkSync(temporary, target);
} finally {
  if (existsSync(temporary)) unlinkSync(temporary);
}
const targetHash = createHash("sha256").update(readFileSync(target)).digest("hex");
if (targetHash !== createHash("sha256").update(imported).digest("hex")) {
  throw new Error("图谱导入后校验失败");
}
console.log(JSON.stringify({ importedEntities: local.entities.length, importedRelations: 0,
  sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"), targetSha256: targetHash, target }, null, 2));
