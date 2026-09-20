import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createChildEnvironment, createRunDirectory, ensureRunSubdirectory, resolveProjectLayout, snapshotTree } from "./isolation-boundary.mjs";

const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(localRoot, "..");
const { projectContainerRoot, originalProjectRoot } = resolveProjectLayout(projectRoot);
const visible = process.argv.includes("--visible");
const nativeUiTurn = process.argv.includes("--native-ui-turn");
const boundedModelUiTurn = process.argv.includes("--bounded-model-ui-turn");
const liveModel = process.argv.includes("--live-model");
const nativeTurn = process.argv.includes("--native-turn") || nativeUiTurn || boundedModelUiTurn;
const realSnapshot = process.argv.includes("--real-snapshot");
const realImportAudit = process.argv.includes("--real-import-audit");
const visibleProbe = process.argv.includes("--visible-probe");
const companionAcceptance = process.argv.includes("--companion-acceptance");
if (liveModel && !boundedModelUiTurn) throw new Error("真实模型只允许受控原生 Chat 页面测试");
if (boundedModelUiTurn && (visible || nativeUiTurn || process.argv.includes("--native-turn")
  || (realSnapshot !== realImportAudit))) {
  throw new Error("受控模型页面测试仅允许隐藏合成模式，或完整快照导入模式");
}
if (realImportAudit && (!realSnapshot || visible)) throw new Error("真实导入对账仅允许隐藏的一次性真实快照运行");
if (visible && nativeTurn) throw new Error("合成原生轮次仅允许隐藏隔离宿主运行");
if (visibleProbe && !visible) throw new Error("可见入口探针必须与 --visible 同时使用");
if (realSnapshot && ((nativeTurn && !realImportAudit) || process.argv.includes("--preflight"))) {
  throw new Error("真实数据快照不能和独立合成轮次或 preflight 同时运行");
}
if (realImportAudit && !nativeTurn) throw new Error("真实导入对账必须包含无网络的合成原生轮次");
if (companionAcceptance && (visible || realSnapshot || nativeTurn)) {
  throw new Error("陪伴能力验收只允许隐藏的合成隔离宿主运行");
}
const runName = visible ? "visible-electron-host" : "full-electron-host";
const installedElectronPackage = [projectRoot, projectContainerRoot]
  .map((root) => path.join(root, "node_modules", "electron", "package.json"))
  .find(existsSync);
if (!installedElectronPackage) throw new Error("找不到当前项目的 Electron 版本信息");
const expectedVersion = JSON.parse(readFileSync(installedElectronPackage, "utf8")).version;
const candidates = [
  path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe"),
  path.join(projectContainerRoot, "node_modules", "electron", "dist", "electron.exe"),
  path.join(originalProjectRoot, "node_modules", "electron", "dist", "electron.exe"),
];

let executable;
for (const candidate of candidates) {
  if (!existsSync(candidate)) continue;
  const version = JSON.parse(readFileSync(path.resolve(candidate, "..", "..", "package.json"), "utf8")).version;
  if (version === expectedVersion) { executable = candidate; break; }
}
if (!executable) throw new Error(`找不到与当前项目匹配的 Electron ${expectedVersion}`);

// 正式 Cyrene 运行时会自行更新用户数据；它与隔离测试并行时，前后哈希不能证明数据未受测试影响。
// 因此先只读检查进程，检测到原版 Electron 就拒绝启动，且此时尚未创建测试目录。
const processProbe = spawnSync("powershell.exe", [
  "-NoProfile", "-NonInteractive", "-Command",
  "@(Get-Process -Name electron -ErrorAction SilentlyContinue | Select-Object Id, Path) | ConvertTo-Json -Compress",
], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
if (processProbe.error || processProbe.status !== 0 || processProbe.stderr?.trim()) {
  throw new Error("无法只读确认原版 Cyrene 已退出；拒绝启动隔离宿主");
}
let electronProcesses;
try {
  electronProcesses = processProbe.stdout.trim() ? JSON.parse(processProbe.stdout.trim()) : [];
} catch {
  throw new Error("无法解析 Electron 进程清单；拒绝启动隔离宿主");
}
const originalElectron = candidates.at(-1).toLowerCase();
const activeOriginal = (Array.isArray(electronProcesses) ? electronProcesses : [electronProcesses])
  .filter((entry) => typeof entry?.Path === "string" && path.resolve(entry.Path).toLowerCase() === originalElectron);
if (activeOriginal.length > 0) {
  throw new Error(`原版 Cyrene 仍在运行（PID ${activeOriginal.map((entry) => entry.Id).join(", ")}）；请正常退出后再运行隔离宿主测试`);
}

for (const name of ["APPDATA", "LOCALAPPDATA", "USERPROFILE"]) {
  if (!process.env[name] || !path.isAbsolute(process.env[name])) {
    throw new Error(`缺少可信的原始 ${name} 绝对路径；拒绝启动`);
  }
}
const protectedRoots = {
  roamingCyrene: path.join(process.env.APPDATA, "live2d-cyrene"),
  localCyrene: path.join(process.env.LOCALAPPDATA, "live2d-cyrene"),
  projectUserData: path.join(originalProjectRoot, "UserData"),
  projectBackup: path.join(originalProjectRoot, "UserData_backup"),
};
const snapshot = () => Object.fromEntries(Object.entries(protectedRoots).map(([name, root]) => {
  try {
    return [name, snapshotTree(root)];
  } catch (error) {
    throw new Error(`受保护数据根 ${name} 无法完整只读校验：${error?.message ?? "unknown"}；拒绝启动`, { cause: error });
  }
}));
const before = snapshot();
if (process.argv.includes("--preflight")) {
  console.log(`[full-electron-host-smoke] preflight ok; protectedRoots=${Object.keys(protectedRoots).length}; Electron not started; no test directory created`);
  process.exit(0);
}
const runRoot = createRunDirectory(localRoot, runName);
try {
let modelSecret = null;
if (boundedModelUiTurn && liveModel) {
  const raw = JSON.parse(readFileSync(path.join(protectedRoots.roamingCyrene, "model-settings.json"), "utf8"));
  const profile = raw.perProvider?.[raw.provider] ?? raw;
  if (raw.provider !== "Kimi（月之暗面）" || profile.model !== "kimi-k2.6" || !profile.apiKey
    || new URL(profile.baseUrl).protocol !== "https:"
    || new URL(profile.baseUrl).hostname !== "api.moonshot.cn") {
    throw new Error("原版主模型并非已授权的官方 Kimi K2.6，拒绝真实请求");
  }
  modelSecret = profile.apiKey;
  // 密钥只暂存本次 -N 运行目录；既不传进命令行，也不写进持久报告。
  writeFileSync(path.join(runRoot, "isolated-model-source.json"), JSON.stringify({
    provider: raw.provider, baseUrl: profile.baseUrl, model: profile.model,
    apiKey: profile.apiKey, explicitTransport: "openai",
    reasoning: profile.reasoning ?? raw.reasoning,
  }));
}
const sourceSnapshot = path.join(runRoot, "source-snapshot");
const sourceRoot = protectedRoots.roamingCyrene;
let sourceSnapshotDigest;
if (realSnapshot) {
  const sourceStat = lstatSync(sourceRoot, { throwIfNoEntry: false });
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("正式用户数据根不是普通目录");
  let sourceBytes = 0;
  const countBytes = (dir) => {
    for (const name of readdirSync(dir)) {
      const item = path.join(dir, name);
      const stat = lstatSync(item);
      if (stat.isSymbolicLink()) throw new Error("正式用户数据含链接，拒绝复制");
      if (stat.isDirectory()) countBytes(item);
      else if (stat.isFile()) sourceBytes += stat.size;
      else throw new Error("正式用户数据含非普通文件，拒绝复制");
    }
  };
  countBytes(sourceRoot);
  const fsInfo = statfsSync(runRoot);
  if (fsInfo.bavail * fsInfo.bsize < sourceBytes + 2 * 1024 ** 3) {
    throw new Error("Cyrene-Agent-N 所在磁盘空间不足以安全暂存完整用户数据");
  }
  console.log(`[full-electron-host-smoke] 正在创建一次性只读快照；源字节=${sourceBytes}`);
  cpSync(sourceRoot, sourceSnapshot, {
    recursive: true, force: false, errorOnExist: true, preserveTimestamps: true,
    filter: (item) => {
      const stat = lstatSync(item);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error("快照源含非普通项，拒绝复制");
      return true;
    },
  });
  sourceSnapshotDigest = snapshotTree(sourceSnapshot, { contentOnly: true });
  if (sourceSnapshotDigest !== snapshotTree(sourceRoot, { contentOnly: true })) {
    throw new Error("用户数据快照与源内容不一致，拒绝启动");
  }
  if (snapshot().roamingCyrene !== before.roamingCyrene) {
    throw new Error("创建快照期间正式用户数据发生变化，拒绝启动");
  }
}
for (const relative of ["app-data", "local-app-data", "home", "temp", "npm-cache"]) {
  ensureRunSubdirectory(runRoot, relative);
}
const childEnv = createChildEnvironment(process.env, runRoot, visible);
childEnv.CYRENE_ISOLATED_NATIVE_TURN = nativeTurn ? "1" : "0";
childEnv.CYRENE_ISOLATED_NATIVE_UI_TURN = nativeUiTurn ? "1" : "0";
childEnv.CYRENE_ISOLATED_BOUNDED_MODEL_UI = boundedModelUiTurn ? "1" : "0";
childEnv.CYRENE_ISOLATED_LIVE_MODEL = liveModel ? "1" : "0";
childEnv.CYRENE_ISOLATED_REAL_SNAPSHOT = realSnapshot ? "1" : "0";
childEnv.CYRENE_ISOLATED_REAL_IMPORT_AUDIT = realImportAudit ? "1" : "0";
childEnv.CYRENE_ISOLATED_VISIBLE_PROBE = visibleProbe ? "1" : "0";
childEnv.CYRENE_ISOLATED_COMPANION_ACCEPTANCE = companionAcceptance ? "1" : "0";
if (realSnapshot) childEnv.CYRENE_ISOLATED_SOURCE_SNAPSHOT = sourceSnapshot;
const entry = path.join(localRoot, "scripts", "full-electron-host-smoke.cjs");
const isolatedUserData = path.join(runRoot, "user-data");
const chromiumArgs = visible ? ["--in-process-gpu"] : [
  "--disable-gpu",
  "--disable-gpu-compositing",
  "--disable-software-rasterizer",
  "--in-process-gpu",
];
const result = spawnSync(executable, [
  ...chromiumArgs,
  entry,
  `--user-data-dir=${isolatedUserData}`,
], {
  cwd: projectRoot,
  encoding: "utf8",
  env: childEnv,
  windowsHide: !visible,
  timeout: visible ? 670_000 : boundedModelUiTurn && liveModel && realSnapshot ? 250_000
    : boundedModelUiTurn ? 145_000 : 70_000,
  maxBuffer: 8 * 1024 * 1024,
});
let after = null;
let integrityCheckError = null;
try {
  after = snapshot();
} catch (error) {
  integrityCheckError = error instanceof Error ? error.message : String(error);
}
const changedRoots = after
  ? Object.keys(protectedRoots).filter((name) => before[name] !== after[name])
  : Object.keys(protectedRoots);
const unchanged = after !== null && changedRoots.length === 0;
const copiedSnapshotUnchanged = !realSnapshot || sourceSnapshotDigest === snapshotTree(sourceSnapshot, { contentOnly: true });
const childResultPath = path.join(runRoot, "child-result.json");
const childResult = existsSync(childResultPath) ? JSON.parse(readFileSync(childResultPath, "utf8")) : null;
const rawStdout = result.stdout ?? "";
const rawStderr = result.stderr ?? "";
const secretLeak = Boolean(modelSecret && (rawStdout.includes(modelSecret) || rawStderr.includes(modelSecret)));
const stdout = modelSecret ? rawStdout.replaceAll(modelSecret, "[REDACTED]") : rawStdout;
const stderr = modelSecret ? rawStderr.replaceAll(modelSecret, "[REDACTED]") : rawStderr;
const pluginsRunning = stdout.includes("[plugins] 已启用 companion-chat@")
  && stdout.includes("[plugins] 已启用 companion-memory@");
const report = {
  ok: result.status === 0 && childResult?.ok === true && childResult?.userData === isolatedUserData
    && childResult?.nativeChatMemoryDisabled === true && pluginsRunning && unchanged && copiedSnapshotUnchanged
    && (!realSnapshot || childResult?.snapshotPreview?.entries > 0)
    && (!realImportAudit || childResult?.importAudit?.passed === true)
    && (!nativeTurn || (childResult?.nativeTurnPassed === true
      && childResult?.promptProviderOrderPassed === true
      && childResult?.nativeRelationshipBypassed === true
      && childResult?.companionLifeStatusVisible === true)) && !secretLeak
    && (!companionAcceptance || childResult?.companionAcceptancePassed === true)
    && (!boundedModelUiTurn || (childResult?.boundedModelPassed === true
      && childResult?.modelTest?.fixtureCalls === (liveModel ? 8 : 9)
      && childResult?.modelTest?.liveCalls === (liveModel ? 1 : 0)
      && childResult?.modelTest?.unexpectedModelCalls === 0
      && childResult?.modelTest?.toolPhaseCalls === 5
      && childResult?.modelTest?.soulPhaseCalls === 3
      && childResult?.modelTest?.visionFixtureCalls === 1
      && childResult?.modelTest?.memoryToolRequested === true
      && childResult?.modelTest?.memoryToolResultObserved === true
      && childResult?.modelTest?.screenToolRequested === true
      && childResult?.modelTest?.screenToolResultObserved === true
      && (!realSnapshot || (childResult?.modelTest?.realSnapshotMemoryInjected === true
        && childResult?.modelTest?.realSnapshotInjectedCount >= 1
        && childResult?.modelTest?.realSnapshotInjectedCount <= 8)))),
  exitCode: result.status,
  signal: result.signal,
  timedOut: result.error?.code === "ETIMEDOUT",
  windowsRevealed: childResult?.windowsRevealed === true,
  protectedUserDataUnchanged: unchanged,
  protectedRootCount: Object.keys(protectedRoots).length,
  changedRoots,
  integrityCheckError,
  secretLeakRedacted: secretLeak,
  isolatedUserDataConfirmed: childResult?.userData === isolatedUserData,
  nativeChatMemoryDisabledConfirmed: childResult?.nativeChatMemoryDisabled === true,
  pluginsMentionedInOutput: pluginsRunning,
  ...(realSnapshot ? { copiedSnapshotUnchanged, snapshotPreview: childResult?.snapshotPreview ?? null } : {}),
  ...(realImportAudit ? { importAudit: childResult?.importAudit ?? null } : {}),
  ...(nativeTurn ? {
    nativeTurnPassed: childResult?.nativeTurnPassed === true,
    promptProviderOrderPassed: childResult?.promptProviderOrderPassed === true,
    nativeRelationshipBypassed: childResult?.nativeRelationshipBypassed === true,
    companionLifeStatusVisible: childResult?.companionLifeStatusVisible === true,
    nativeUiTurn,
  } : {}),
  ...(companionAcceptance ? { companionAcceptancePassed: childResult?.companionAcceptancePassed === true,
    companionAcceptance: childResult?.companionAcceptance ?? null } : {}),
  ...(boundedModelUiTurn ? { boundedModelPassed: childResult?.boundedModelPassed === true,
    liveModel, modelTest: childResult?.modelTest ?? null } : {}),
};
writeFileSync(path.join(runRoot, "stdout.log"), stdout);
writeFileSync(path.join(runRoot, "stderr.log"), stderr);
writeFileSync(path.join(runRoot, "result.json"), JSON.stringify(report, null, 2));
process.stdout.write(stdout);
process.stderr.write(stderr);
console.log(`[full-electron-host-smoke] ${JSON.stringify(report)}`);
if (!report.ok) process.exitCode = result.status || 1;
} finally {
  // 合成与真实快照都只清理由本次创建的、经过隔离入口验证的运行目录；源目录绝不在清理范围内。
  const expectedParent = path.join(localRoot, ".test-runtime", runName);
  if (path.resolve(path.dirname(runRoot)).toLowerCase() !== path.resolve(expectedParent).toLowerCase()
    || !/^run-\d+-[0-9a-f-]{36}$/.test(path.basename(runRoot))
    || realpathSync(expectedParent).toLowerCase() !== path.resolve(expectedParent).toLowerCase()
    || lstatSync(runRoot).isSymbolicLink()) {
    throw new Error("一次性测试目录清理边界无法验证，拒绝删除");
  }
  rmSync(runRoot, { recursive: true, force: false, maxRetries: 3, retryDelay: 500 });
  if (existsSync(runRoot)) throw new Error("一次性测试目录清理未完成");
  const testRuntimeRoot = path.join(localRoot, ".test-runtime");
  for (const emptyParent of [expectedParent, testRuntimeRoot]) {
    const entry = lstatSync(emptyParent, { throwIfNoEntry: false });
    if (entry?.isDirectory() && !entry.isSymbolicLink() && readdirSync(emptyParent).length === 0) {
      rmdirSync(emptyParent);
    }
  }
  console.log("[full-electron-host-smoke] 本次临时快照及运行数据已清除");
}
