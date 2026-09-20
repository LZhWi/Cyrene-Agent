const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

const localRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(localRoot, "..");
const runRoot = path.join(localRoot, ".test-runtime", "electron-host");
const userDataRoot = path.join(runRoot, "user-data");

function assertInsideLocalRoot(target, expectedRelative) {
  const relative = path.relative(localRoot, target);
  if (relative !== expectedRelative || path.isAbsolute(relative)) {
    throw new Error(`Electron 隔离路径越界: ${target}`);
  }
}

function prepareIsolatedPaths() {
  assertInsideLocalRoot(runRoot, path.join(".test-runtime", "electron-host"));
  const existing = fs.lstatSync(runRoot, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) throw new Error("Electron 隔离目录不能是符号链接");
  fs.rmSync(runRoot, { recursive: true, force: true });

  const paths = {
    userData: userDataRoot,
    sessionData: path.join(runRoot, "session-data"),
    logs: path.join(runRoot, "logs"),
    crashDumps: path.join(runRoot, "crash-dumps"),
    temp: path.join(runRoot, "temp"),
  };
  for (const target of Object.values(paths)) fs.mkdirSync(target, { recursive: true });
  for (const [name, target] of Object.entries(paths)) app.setPath(name, target);
  app.setAppLogsPath(paths.logs);
  app.commandLine.appendSwitch("disable-gpu");

  const pluginRoot = path.join(userDataRoot, "plugins");
  fs.mkdirSync(pluginRoot, { recursive: true });
  for (const pluginId of ["companion-chat", "companion-memory"]) {
    const source = path.join(localRoot, "artifacts", pluginId);
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`缺少插件构建产物: ${pluginId}`);
    }
    fs.cpSync(source, path.join(pluginRoot, pluginId), { recursive: true });
  }
  fs.writeFileSync(
    path.join(userDataRoot, "app-settings.json"),
    JSON.stringify({ plugins: { "companion-chat": true, "companion-memory": true } }, null, 2),
    "utf8",
  );
  return paths;
}

function createSchedulerStore() {
  const tasks = [];
  return {
    getTasks: () => [...tasks],
    addTask: () => { throw new Error("Electron 隔离验收不允许创建调度任务"); },
    updateTask: () => { throw new Error("Electron 隔离验收不允许更新调度任务"); },
    deleteTask: () => false,
    getHistory: () => [],
    deleteTasksByOwner: () => 0,
  };
}

async function main() {
  const isolatedPaths = prepareIsolatedPaths();
  const watchdog = setTimeout(() => app.exit(124), 30_000);
  await app.whenReady();

  const { createIpcScope } = require(path.join(projectRoot, "dist", "main", "main", "application", "ipc-scope.js"));
  const { startPluginRuntime } = require(path.join(projectRoot, "dist", "main", "main", "plugin-runtime.js"));
  const ipcScope = createIpcScope();
  let manager;
  try {
    manager = await startPluginRuntime({
      llmClient: new Proxy({}, { get: () => { throw new Error("Electron 隔离验收禁止模型调用"); } }),
      ipc: ipcScope,
      schedulerStore: createSchedulerStore(),
    });
    const overview = manager.overview();
    const statuses = Object.fromEntries(overview.plugins.map((plugin) => [plugin.id, plugin.status]));
    if (overview.issues.length || statuses["companion-chat"] !== "running" || statuses["companion-memory"] !== "running") {
      throw new Error(`插件启动状态异常: ${JSON.stringify(overview)}`);
    }
    fs.writeFileSync(
      path.join(runRoot, "result.json"),
      JSON.stringify({ ok: true, isolatedPaths, overview }, null, 2),
      "utf8",
    );
    console.log(`[electron-host-smoke] ok userData=${isolatedPaths.userData}`);
  } finally {
    if (manager) await manager.stop();
    ipcScope.dispose();
    clearTimeout(watchdog);
  }
}

void main().then(() => app.exit(0)).catch((error) => {
  console.error("[electron-host-smoke] failed", error);
  app.exit(1);
});
