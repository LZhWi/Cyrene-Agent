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
import { createApplication } from "./application/application";
import { createDefaultApplicationDependencies } from "./application/default-dependencies";
import { CURRENT_MEMORY_SCHEMA_VERSION } from "./memory/memory-store-defaults";
import { registerPluginPanelScheme } from "./plugin-panel-protocol";
import { inspectUserDataSafety } from "./user-data-safety";

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
  // 插件设置面板协议：scheme 特权必须在 app.ready 之前注册（Electron 硬性要求）
  registerPluginPanelScheme();

  const application = createApplication(createDefaultApplicationDependencies());

  application.installLifecycleHandlers();
  application.prepareBeforeReady();

  if (application.isPrimaryProcess()) {
    void app.whenReady()
      .then(() => application.start())
      .catch((error) => application.handleFatalStartup(error));
  }
}
