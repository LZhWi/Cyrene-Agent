/**
 * Electron 主进程入口 —— 应用组合根（Composition Root）。
 *
 * 此文件只表达应用生命周期：创建 Application、绑定 Electron 生命周期、
 * 在 ready 前完成同步预配置，并在主进程就绪后按
 * shell → core → background 阶段启动。全部业务子系统的装配位于
 * application/default-dependencies.ts；启动编排位于 application/application.ts。
 */

import { app, dialog } from "electron";
import * as path from "node:path";
import * as fs from "node:fs";
import { CURRENT_MEMORY_SCHEMA_VERSION } from "./memory/memory-store-defaults";
import { inspectUserDataSafety } from "./user-data-safety";
import { prepareChatMigration, commitChatMigration, resolveChatMigrationData, rollbackChatMigration } from "./chats/chat-migration-transaction";

// 打包版双击启动时 stdout/stderr 管道可能不存在或中途关闭，
// 此时任何 console.log 写入都会抛异步 EPIPE 并升级成 uncaughtException 弹错误框
// （如 mcp-adapter connectMcpServer 的连接日志）。在入口最顶部挂 error 监听器
// 静默兜底：日志丢弃无害，业务不受影响。
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return;
    throw err;
  });
}

const startupUserDataPath = app.getPath("userData");
const userDataSafety = inspectUserDataSafety({
  userDataPath: startupUserDataPath,
  // Electron 还未 ready 时部分版本不能读取 appData；Windows 优先使用同源环境变量，
  // 其他环境退回 userData 父目录。这里只用于路径比较，不创建或修改目录。
  appDataPath: process.env.APPDATA || path.dirname(startupUserDataPath),
  supportedMemorySchemaVersion: CURRENT_MEMORY_SCHEMA_VERSION,
});

if (!userDataSafety.safe) {
  const message = `${userDataSafety.reason}\n\n请使用 npm run start:isolated，或显式提供独立的 --user-data-dir。`;
  console.error(`[UserDataSafety] ${message}`);
  dialog.showErrorBox("Cyrene-Agent-N 已阻止不安全启动", message);
  app.exit(78);
} else {
  startPrimary();
}

function startPrimary() {
  // Keep the lock on the stable root, not on a generation that changes after import.
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  const sqliteSupport = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked/dist/sqlite-runtime") : path.resolve(__dirname, "../../sqlite-runtime");
  const rollbackSqlite = process.argv.includes("--rollback-sqlite");
  if(rollbackSqlite){console.error("SQLITE_JSON_ROLLBACK_RETIRED: use --restore-sqlite");app.exit(78);return;}
  let committedThisLaunch = false;
  try {
    fs.mkdirSync(startupUserDataPath, { recursive: true });
    const candidate = process.argv.find(arg => arg.startsWith("--import-chat-package="))?.slice("--import-chat-package=".length);
    const rollback = process.argv.includes("--rollback-chat-migration");
    const sqliteControl = path.join(resolveChatMigrationData(startupUserDataPath), ".sqlite-storage");
    const sqliteSelected = ["active.json", "activation.json"].some(file => fs.existsSync(path.join(sqliteControl, file)));
    if((candidate||rollback)&&fs.existsSync(sqliteControl))require(path.join(sqliteSupport,'formal-storage.cjs')).selection(path.dirname(sqliteControl));
    if (rollbackSqlite && (candidate || rollback || process.argv.includes("--enable-sqlite"))) throw new Error("一次只能执行一个存储迁移操作");
    if ((candidate || rollback) && (sqliteSelected || process.argv.includes("--enable-sqlite"))) throw new Error("SQLite 启用后不能用旧 JSON 导入或回滚，请先执行保留新数据的存储恢复流程");
    if (candidate && rollback) throw new Error("导入与回滚不能同时执行");
    if (rollback) rollbackChatMigration(startupUserDataPath);
    if (candidate) {
      const prepared = prepareChatMigration(startupUserDataPath, path.resolve(candidate));
      if (!prepared.unchanged && prepared.id) { commitChatMigration(startupUserDataPath, prepared.id); committedThisLaunch = true; }
    }
    let selected = resolveChatMigrationData(startupUserDataPath);
    if (!rollbackSqlite && ["rollback.json", "rollback-intent.json"].some(file => fs.existsSync(path.join(selected, ".sqlite-storage", file)))) {
      selected = require(path.join(sqliteSupport, "rollback-storage.cjs")).resolveRollbackData(selected);
    }
    const snapshotArg=process.argv.find(arg=>arg.startsWith('--snapshot-sqlite='))?.slice('--snapshot-sqlite='.length);
    const restoreArg=process.argv.find(arg=>arg.startsWith('--restore-sqlite='))?.slice('--restore-sqlite='.length);
    const retireArg=process.argv.find(arg=>arg.startsWith('--retire-legacy-json='))?.slice('--retire-legacy-json='.length);
    if(retireArg){
      if(snapshotArg||restoreArg||candidate||rollback||process.argv.includes('--enable-sqlite'))throw Error('一次只能执行一个存储操作');
      void (async()=>{
        const options=require(path.join(sqliteSupport,'formal-storage.cjs')).options(selected,sqliteSupport);
        if(!options)throw Error('SQLITE_NOT_INITIALIZED');
        const owner=require(path.join(sqliteSupport,'bridge.cjs'))(options);
        try{owner.start();require(path.join(sqliteSupport,'startup-service-import.cjs')).importServices(selected,owner.call);}
        finally{await owner.stop();}
        const result=require(path.join(sqliteSupport,'legacy-retirement.cjs')).retire(selected,path.resolve(retireArg));
        console.log('[LegacyRetirement]',JSON.stringify({removed:result.removed.length,backup:result.backup}));app.exit(0);
      })().catch(error=>{console.error('[LegacyRetirement]',error);app.exit(78);});return;
    }
    if(snapshotArg||restoreArg){
      if((snapshotArg&&restoreArg)||candidate||rollback||rollbackSqlite||process.argv.includes('--enable-sqlite'))throw Error('一次只能执行一个存储操作');
      const snapshots=require(path.join(sqliteSupport,'profile-snapshot.cjs'));
      const result=restoreArg?snapshots.restore(selected,path.resolve(restoreArg)):snapshots.capture(selected,path.resolve(snapshotArg!));
      console.log('[SQLiteSnapshot]',JSON.stringify(result));app.exit(0);return;
    }
    if(fs.existsSync(path.join(selected,'.sqlite-restore-pending.json')))throw Error('SQLITE_RESTORE_INCOMPLETE: 请用原快照重新执行 --restore-sqlite 完成恢复');
    if(fs.existsSync(path.join(selected,'.sqlite-storage')))require(path.join(sqliteSupport,'formal-storage.cjs')).selection(selected,process.argv.includes('--enable-sqlite'));
    const safety = inspectUserDataSafety({ userDataPath: selected, appDataPath: process.env.APPDATA || path.dirname(startupUserDataPath), supportedMemorySchemaVersion: CURRENT_MEMORY_SCHEMA_VERSION });
    if (!safety.safe) throw new Error(safety.reason);
    app.setPath("userData", selected);
    if (selected !== startupUserDataPath) {
      const sessionData = path.join(selected, "session-data"); fs.mkdirSync(sessionData, { recursive: true }); app.setPath("sessionData", sessionData);
    }
  } catch (error) {
    if (committedThisLaunch) rollbackChatMigration(startupUserDataPath);
    dialog.showErrorBox("聊天数据迁移失败", String(error)); app.exit(78); return;
  }
  if (process.argv.includes("--enable-sqlite") || rollbackSqlite) {
    const operation = rollbackSqlite ? require(path.join(sqliteSupport, "rollback-storage.cjs")).rollback : require(path.join(sqliteSupport, "formal-storage.cjs")).migrate;
    void operation(app.getPath("userData"), sqliteSupport)
      .then((result: unknown) => { console.log("[SQLiteMigration]", JSON.stringify(result)); app.exit(0); })
      .catch((error: Error) => { console.error("[SQLiteMigration]", error); app.exit(78); });
    return;
  }
  try {
    // Lazy imports are required: several stores capture userData at module load.
    const { registerPluginPanelScheme } = require("./plugin-panel-protocol") as typeof import("./plugin-panel-protocol");
    const { createApplication } = require("./application/application") as typeof import("./application/application");
    const { createDefaultApplicationDependencies } = require("./application/default-dependencies") as typeof import("./application/default-dependencies");
    // 插件设置面板协议：scheme 特权必须在 app.ready 之前注册（Electron 硬性要求）
    registerPluginPanelScheme();

    const application = createApplication(createDefaultApplicationDependencies());

    application.installLifecycleHandlers();
    application.prepareBeforeReady();

    if (application.isPrimaryProcess()) {
      void app.whenReady()
        .then(async () => {
          // Pre-ready scheme/GPU setup remains synchronous; storage is ready before business startup.
          await require(path.join(sqliteSupport,'formal-storage.cjs')).migrate(app.getPath('userData'),sqliteSupport);
          require('./storage/storage-backend').getStorageRuntime();
          return application.start();
        })
        .catch((error) => {
          if (committedThisLaunch) rollbackChatMigration(startupUserDataPath);
          return application.handleFatalStartup(error);
        });
    }
  } catch (error) {
    if (committedThisLaunch) rollbackChatMigration(startupUserDataPath);
    dialog.showErrorBox("聊天数据迁移启动失败", String(error)); app.exit(78);
  }
}
