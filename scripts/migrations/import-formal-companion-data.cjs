const { createHash, randomUUID } = require("node:crypto");
const { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..", "..");
const containerRoot = path.resolve(projectRoot, "..");
if (path.basename(projectRoot) !== ".upstream-latest" || path.basename(containerRoot) !== "Cyrene-Agent-N") {
  throw new Error("只允许在 Cyrene-Agent-N/.upstream-latest 中执行正式导入");
}

const appDataRoot = path.join(containerRoot, "AppData");
const nUserDataRelative = path.join("Roaming", "live2d-cyrene-n");
const sourceRoot = path.join(process.env.APPDATA || "", "live2d-cyrene");
const sourceMemory = path.join(sourceRoot, "memory.json");
const sourceVectors = path.join(sourceRoot, "rag-data", "memory-store.json");
const originalProject = path.join(path.dirname(containerRoot), "Cyrene-Agent");
const artifacts = path.join(projectRoot, "local-plugins", "artifacts");
const apply = process.argv.includes("--apply");

function assertOrdinaryFile(file, expectedName) {
  if (!path.isAbsolute(file) || path.basename(file).toLowerCase() !== expectedName) throw new Error(`源文件名无效: ${file}`);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`源文件不是普通文件: ${file}`);
}

function fileHash(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function assertNoElectron() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-Process -Name electron -ErrorAction SilentlyContinue | Select-Object Id,Path) | ConvertTo-Json -Compress"],
  { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error || result.status !== 0 || result.stderr.trim()) throw new Error("无法确认 Electron 已退出");
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : [];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const active = list.filter((item) => typeof item?.Path === "string"
    && path.resolve(item.Path).toLowerCase().includes(path.resolve(containerRoot).toLowerCase()));
  if (active.length) throw new Error(`Cyrene-Agent-N 仍在运行: ${active.map((item) => item.Id).join(",")}`);
}

function createServices() {
  const secrets = new Map();
  return {
    createForPlugin() {
      return {
        llm: { generateText: async () => { throw new Error("正式导入禁止调用模型"); } },
        secrets: {
          get: async (key) => secrets.get(key),
          set: async (key, value) => { secrets.set(key, value); },
          delete: async (key) => secrets.delete(key),
        },
        conversations: { list: async () => ({ items: [] }), getMessages: async () => ({ items: [] }) },
        assistantDelivery: { postProactiveMessage: async () => { throw new Error("正式导入禁止主动消息"); } },
        screenObservation: { observe: async () => { throw new Error("正式导入禁止屏幕观察"); } },
        userPresence: { snapshot: async () => ({ at: new Date(0).toISOString(), idleSeconds: 0, screenLocked: false }) },
        weatherContext: { snapshot: async () => null },
        memoryRetrieval: {
          embed: async () => { throw new Error("正式导入禁止生成新向量"); },
          rank: async () => { throw new Error("正式导入禁止重排"); },
        },
      };
    },
  };
}

async function installPlugin(zip, userPluginRoot) {
  const { preparePluginZip, commitPreparedPlugin } = require(path.join(projectRoot, "dist", "main", "plugins", "installer.js"));
  const prepared = await preparePluginZip(zip, userPluginRoot);
  return commitPreparedPlugin(prepared, userPluginRoot, false);
}

async function importInto(stagedAppData) {
  const userData = path.join(stagedAppData, nUserDataRelative);
  const pluginRoot = path.join(userData, "plugins");
  const storageRoot = path.join(userData, "plugin-data");
  if (existsSync(path.join(pluginRoot, "companion-memory")) || existsSync(path.join(storageRoot, "companion-memory"))) {
    throw new Error("目标插件或记忆库已存在，拒绝覆盖");
  }
  await installPlugin(path.join(artifacts, "companion-chat.zip"), pluginRoot);
  await installPlugin(path.join(artifacts, "companion-memory.zip"), pluginRoot);

  const { PluginManager } = require(path.join(projectRoot, "dist", "main", "plugins", "manager.js"));
  const { createPluginPromptRegistry } = require(path.join(projectRoot, "dist", "main", "plugins", "prompts.js"));
  const ipc = new Map();
  const manager = new PluginManager({
    scanRoots: [{ path: pluginRoot, source: "user" }], storageRoot,
    runtime: {
      toolRegistry: { register: () => undefined, unregister: () => true },
      channelManager: { has: () => false, register: () => undefined, unregister: async () => true, startOne: async () => undefined },
      registerIpc: (channel, handler) => ipc.set(channel, handler),
      unregisterIpc: (channel) => ipc.delete(channel),
      promptRegistry: createPluginPromptRegistry(), hostServices: createServices(),
    },
    loadEnabledMap: () => ({ "companion-memory": true, "companion-chat": false }),
    saveEnabledMap: () => undefined,
  });
  await manager.start();
  try {
    const invoke = async (action, data) => {
      const handler = ipc.get("plugin:companion-memory:ui");
      if (!handler) throw new Error("记忆插件 UI IPC 未注册");
      const result = await handler(action, data);
      if (result?.ok !== true) throw new Error(`${action}: ${result?.error || "失败"}`);
      return result.data;
    };
    const preview = await invoke("preview-legacy-import", { sourcePath: sourceMemory });
    if (!preview?.canImport || preview.entries?.total < 1) throw new Error("正式记忆预检无可导入条目");
    const before = await invoke("state");
    if (before.entries?.length || before.evidence?.length || before.revision !== 0) throw new Error("目标记忆库不是全新空库");
    const imported = await invoke("import-legacy", {
      sourcePath: sourceMemory, sourceHash: preview.sourceHash, revision: before.revision,
      sourceAttested: true, preserveRuntime: true,
    });
    const vectorPreview = await invoke("preview-legacy-vectors", { sourcePath: sourceVectors });
    const vectors = await invoke("import-legacy-vectors", { sourcePath: sourceVectors, sourceHash: vectorPreview.sourceHash });
    const after = await invoke("state");
    if (after.entries?.length !== imported.importedEntries || after.evidence?.length !== imported.importedEvidence
      || after.vectorIndex?.entries !== vectors.entries || after.legacyImport?.sourceAttested !== true
      || after.legacyImport?.runtimePreserved !== true) throw new Error("导入后状态与回执不一致");
    return { preview, imported, vectorPreview, vectors, state: {
      revision: after.revision, entries: after.entries.length, evidence: after.evidence.length,
      profiles: Object.keys(after.profiles?.l0 || {}).length + Object.keys(after.profiles?.l1 || {}).length,
      vectorEntries: after.vectorIndex.entries, vectorDimensions: after.vectorIndex.dimensions,
      runtimePreserved: after.legacyImport.runtimePreserved, sourceAttested: after.legacyImport.sourceAttested,
    } };
  } finally {
    await manager.stop();
  }
}

async function main() {
  assertNoElectron();
  assertOrdinaryFile(sourceMemory, "memory.json");
  assertOrdinaryFile(sourceVectors, "memory-store.json");
  if (!existsSync(appDataRoot) || lstatSync(appDataRoot).isSymbolicLink()) throw new Error("-N AppData 边界无效");
  const sourceBefore = { memory: fileHash(sourceMemory), vectors: fileHash(sourceVectors) };
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const stagingParent = path.join(containerRoot, ".formal-import-staging");
  const stagedAppData = path.join(stagingParent, runId, "AppData");
  const backupRoot = path.join(containerRoot, "AppData_import_backup", runId);
  mkdirSync(path.dirname(stagedAppData), { recursive: true });
  cpSync(appDataRoot, stagedAppData, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  const result = await importInto(stagedAppData);
  const sourceAfter = { memory: fileHash(sourceMemory), vectors: fileHash(sourceVectors) };
  if (JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)) throw new Error("正式源文件在导入期间发生变化");

  if (!apply) {
    rmSync(path.join(stagingParent, runId), { recursive: true, force: false });
    console.log(JSON.stringify({ ok: true, dryRun: true, sourceUnchanged: true, result }, null, 2));
    return;
  }

  mkdirSync(backupRoot, { recursive: true });
  cpSync(appDataRoot, path.join(backupRoot, "AppData"), { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  const settingsFile = path.join(stagedAppData, nUserDataRelative, "app-settings.json");
  const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  settings.plugins = { ...(settings.plugins || {}), "companion-chat": true, "companion-memory": true };
  settings.chatBackend = "native";
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const displaced = path.join(stagingParent, runId, "AppData-before-swap");
  renameSync(appDataRoot, displaced);
  try {
    renameSync(stagedAppData, appDataRoot);
  } catch (error) {
    renameSync(displaced, appDataRoot);
    throw error;
  }
  rmSync(displaced, { recursive: true, force: false });
  rmSync(path.join(stagingParent, runId), { recursive: true, force: false });
  const reportDir = path.join(containerRoot, "ImportReports");
  mkdirSync(reportDir, { recursive: true });
  const report = { ok: true, applied: true, runId, sourceUnchanged: true, backup: path.join(backupRoot, "AppData"), result };
  writeFileSync(path.join(reportDir, `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`[formal-companion-import] ${error?.stack || error}`);
  process.exitCode = 1;
});
