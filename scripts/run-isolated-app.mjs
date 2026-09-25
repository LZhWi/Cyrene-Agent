import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const containerRoot = path.basename(projectRoot) === ".upstream-latest"
  ? path.dirname(projectRoot)
  : projectRoot;
if (path.basename(containerRoot) !== "Cyrene-Agent-N") {
  throw new Error("隔离启动入口只能在 Cyrene-Agent-N 内运行");
}

function assertPlainDirectory(directory) {
  const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`隔离目录不存在或不是普通目录：${directory}`);
  }
}

function ensurePlainChild(parent, name) {
  assertPlainDirectory(parent);
  if (!name || path.basename(name) !== name || name === "." || name === "..") {
    throw new Error(`非法隔离目录名：${name}`);
  }
  const child = path.join(parent, name);
  if (!fs.existsSync(child)) fs.mkdirSync(child);
  assertPlainDirectory(child);
  return child;
}

function assertOwnedUserData(userData) {
  const markerPath = path.join(userData, ".cyrene-n-user-data.json");
  if (fs.existsSync(markerPath)) {
    const markerEntry = fs.lstatSync(markerPath);
    if (!markerEntry.isFile() || markerEntry.isSymbolicLink()) {
      throw new Error("Cyrene-Agent-N 用户数据归属标记不是普通文件");
    }
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker?.kind !== "cyrene-agent-n-user-data" || marker?.version !== 1) {
      throw new Error("Cyrene-Agent-N 用户数据归属标记无效");
    }
    return;
  }
  if (fs.readdirSync(userData).length > 0) {
    throw new Error("持久用户数据目录非空且没有 Cyrene-Agent-N 归属标记，拒绝使用");
  }
  fs.writeFileSync(markerPath, `${JSON.stringify({
    kind: "cyrene-agent-n-user-data",
    version: 1,
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

const electronPackage = [projectRoot, containerRoot]
  .map((root) => path.join(root, "node_modules", "electron", "package.json"))
  .find(fs.existsSync);
if (!electronPackage) throw new Error("找不到当前 Cyrene-Agent-N 的 Electron");
const executable = path.join(path.dirname(electronPackage), "dist", "electron.exe");
if (!fs.existsSync(executable)) throw new Error(`Electron 可执行文件不存在：${executable}`);

assertPlainDirectory(containerRoot);
const temporary = process.argv.includes("--temporary");
const preflight = process.argv.includes("--preflight");
let runtimeRoot;
let runRoot;
let paths;

if (temporary) {
  runtimeRoot = ensurePlainChild(containerRoot, ".runtime");
  runRoot = ensurePlainChild(runtimeRoot, `session-${Date.now()}-${crypto.randomUUID()}`);
  paths = {
    appData: ensurePlainChild(runRoot, "app-data"),
    localAppData: ensurePlainChild(runRoot, "local-app-data"),
    home: ensurePlainChild(runRoot, "home"),
    temp: ensurePlainChild(runRoot, "temp"),
    userData: ensurePlainChild(runRoot, "user-data"),
  };
} else {
  const appDataRoot = ensurePlainChild(containerRoot, "AppData");
  const roaming = ensurePlainChild(appDataRoot, "Roaming");
  const local = ensurePlainChild(appDataRoot, "Local");
  paths = {
    appData: roaming,
    localAppData: local,
    home: ensurePlainChild(appDataRoot, "Profile"),
    temp: ensurePlainChild(appDataRoot, "Temp"),
    userData: ensurePlainChild(roaming, "live2d-cyrene-n"),
  };
  assertOwnedUserData(paths.userData);
}

// Windows 文件选择器会按 USERPROFILE 拼出这些已知目录。隔离 Profile 若缺少
// Desktop，会弹出“位置不可用”系统对话框；全部建在 Cyrene-Agent-N 内，
// 既不回退到真实用户目录，也不需要修改注册表中的 Known Folder 配置。
for (const directory of ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]) {
  ensurePlainChild(paths.home, directory);
}

function cleanupTemporaryRun() {
  if (!temporary || !runtimeRoot || !runRoot) return;
  assertPlainDirectory(runtimeRoot);
  assertPlainDirectory(runRoot);
  fs.rmSync(runRoot, { recursive: true, force: true });
  if (fs.readdirSync(runtimeRoot).length === 0) fs.rmdirSync(runtimeRoot);
}

if (preflight) {
  console.log(JSON.stringify({ mode: temporary ? "temporary" : "persistent", paths }, null, 2));
  cleanupTemporaryRun();
  process.exit(0);
}

let exitCode = 1;
try {
  const child = spawn(executable, [projectRoot, `--user-data-dir=${paths.userData}`], {
    cwd: projectRoot,
    env: {
      ...process.env,
      APPDATA: paths.appData,
      LOCALAPPDATA: paths.localAppData,
      USERPROFILE: paths.home,
      HOME: paths.home,
      TEMP: paths.temp,
      TMP: paths.temp,
      TMPDIR: paths.temp,
      ...(temporary ? { CYRENE_ISOLATED_RUN_ROOT: runRoot } : {}),
    },
    stdio: "inherit",
  });

  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  cleanupTemporaryRun();
}

process.exitCode = exitCode;
