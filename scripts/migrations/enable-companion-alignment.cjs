const { createHash, randomUUID } = require("node:crypto");
const { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..", "..");
const containerRoot = path.resolve(projectRoot, "..");
if (path.basename(projectRoot) !== ".upstream-latest" || path.basename(containerRoot) !== "Cyrene-Agent-N") {
  throw new Error("只允许在 Cyrene-Agent-N/.upstream-latest 中执行陪伴系统对齐");
}

const userDataRoot = path.join(containerRoot, "AppData", "Roaming", "live2d-cyrene-n");
const chatRoot = path.join(userDataRoot, "plugin-data", "companion-chat");
const memoryRoot = path.join(userDataRoot, "plugin-data", "companion-memory");
const reportRoot = path.join(containerRoot, "AlignmentReports");
const apply = process.argv.includes("--apply");

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

function readJson(file) {
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`目标不是普通文件: ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function atomicWriteJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporary, file);
}

function main() {
  assertNoCyreneN();
  const memoryStateFile = path.join(memoryRoot, "memory-state.json");
  const vectorStateFile = path.join(memoryRoot, "vector-index.json");
  const memoryState = readJson(memoryStateFile);
  const vectorState = readJson(vectorStateFile);
  if (!Array.isArray(memoryState.entries) || !Array.isArray(vectorState.entries)) {
    throw new Error("正式记忆或向量索引格式不兼容");
  }
  const now = Date.now();
  const memoryById = new Map(memoryState.entries.map((entry) => [entry.id, entry]));
  const vectorIds = new Set(vectorState.entries.map((entry) => entry.l2Id));
  const isRecallable = (entry) => (entry.status === "active" || entry.status === "aging")
    && !entry.supersededBy && !entry.mergedInto
    && (entry.validFrom === undefined || entry.validFrom <= now)
    && (entry.validTo === undefined || entry.validTo > now);
  const recallableIds = new Set(memoryState.entries.filter(isRecallable).map((entry) => entry.id));
  const baselineHashes = {};
  for (const id of vectorIds) {
    const entry = memoryById.get(id);
    if (entry && typeof entry.content === "string") baselineHashes[id] = sha256(entry.content);
  }

  const writes = new Map([
    [path.join(chatRoot, "memory-link.json"), { enabled: true }],
    [path.join(chatRoot, "proactive-controller.json"), {
      version: 1, enabled: true, feedbackLearningEnabled: false, epoch: 0,
      unansweredCount: 0, lastActivityAt: now, lastSentAt: null,
    }],
    [path.join(memoryRoot, "semantic-index-settings.json"), { enabled: true }],
    [path.join(memoryRoot, "semantic-index-baseline.json"), { version: 1, hashes: baselineHashes }],
    [path.join(memoryRoot, "auto-maintenance-enabled.json"), true],
    [path.join(memoryRoot, "auto-review-enabled.json"), true],
    [path.join(memoryRoot, "auto-review-apply-enabled.json"), true],
    [path.join(memoryRoot, "auto-compression-enabled.json"), true],
    [path.join(memoryRoot, "auto-compression-apply-enabled.json"), true],
    [path.join(memoryRoot, "auto-reflection-enabled.json"), true],
    [path.join(memoryRoot, "auto-lifecycle-enabled.json"), true],
    [path.join(memoryRoot, "auto-lifecycle-apply-enabled.json"), true],
    [path.join(memoryRoot, "auto-dream-enabled.json"), true],
    [path.join(memoryRoot, "auto-dream-apply-enabled.json"), true],
  ]);

  const plan = {
    userDataRoot,
    memories: memoryState.entries.length,
    vectors: vectorState.entries.length,
    recallableMemories: recallableIds.size,
    recallableMemoriesWithoutVector: [...recallableIds].filter((id) => !vectorIds.has(id)).length,
    vectorsForNonRecallableMemories: [...vectorIds].filter((id) => !recallableIds.has(id)).length,
    semanticBaselineEntries: Object.keys(baselineHashes).length,
    semanticBackfillCandidates: memoryState.entries.filter((entry) => isRecallable(entry) && !vectorIds.has(entry.id)).length,
    unindexedNonRecallableMemories: memoryState.entries.filter((entry) => !isRecallable(entry) && !vectorIds.has(entry.id)).length,
    screenObservationEnabled: false,
    reason: "未配置视觉模型，只保留已验通的手动观察通路",
    files: [...writes.keys()].map((file) => path.relative(userDataRoot, file)),
  };
  if (!apply) {
    console.log(JSON.stringify({ ok: true, dryRun: true, plan }, null, 2));
    return;
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const backupRoot = path.join(containerRoot, "AppData_alignment_backup", runId);
  const backups = [];
  for (const [file, value] of writes) {
    if (existsSync(file)) {
      const relative = path.relative(userDataRoot, file);
      const backup = path.join(backupRoot, relative);
      mkdirSync(path.dirname(backup), { recursive: true });
      writeFileSync(backup, readFileSync(file), { flag: "wx" });
      backups.push(relative);
    }
    atomicWriteJson(file, value);
  }
  mkdirSync(reportRoot, { recursive: true });
  const report = { ok: true, applied: true, runId, plan, backupRoot, backups };
  atomicWriteJson(path.join(reportRoot, `${runId}.json`), report);
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[enable-companion-alignment] ${error?.stack || error}`);
  process.exitCode = 1;
}
