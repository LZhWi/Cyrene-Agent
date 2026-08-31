/**
 * Electron 退出事件适配层：
 * before-quit 只作为兜底入口 —— 首次触发时阻止默认退出并进入受控退出；
 * finalizing 之后的退出直接放行（最终动作触发的退出不得再次被拦截）。
 * Windows 会话结束事件只做同步紧急落盘，绝不等慢清理。
 */

import type { ShutdownCoordinator } from "./shutdown";

export interface AppLifecycleLike {
  on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  removeListener(event: "before-quit", listener: (event: { preventDefault(): void }) => void): void;
  quit(): void;
}

export interface SessionEndWindowLike {
  on(event: "query-session-end" | "session-end", listener: (event: { preventDefault(): void }) => void): void;
  removeListener(event: "query-session-end" | "session-end", listener: (event: { preventDefault(): void }) => void): void;
}

export function installAppShutdownHandlers(input: {
  app: AppLifecycleLike;
  coordinator: ShutdownCoordinator;
}): () => void {
  const { app, coordinator } = input;
  const onBeforeQuit = (event: { preventDefault(): void }) => {
    if (coordinator.isFinalizing()) return;
    event.preventDefault();
    void coordinator.requestControlledShutdown({
      reason: "before-quit",
      finalAction: () => app.quit(),
    });
  };
  app.on("before-quit", onBeforeQuit);
  return () => {
    app.removeListener("before-quit", onBeforeQuit);
  };
}

export function attachWindowsSessionEndHandlers(input: {
  window: SessionEndWindowLike;
  coordinator: ShutdownCoordinator;
}): () => void {
  const { window, coordinator } = input;
  const onSessionEnd = () => {
    // 只做同步、幂等的关键数据落盘；不调用慢清理、不阻止系统退出。
    coordinator.emergencyFlush();
  };
  window.on("query-session-end", onSessionEnd);
  window.on("session-end", onSessionEnd);
  return () => {
    window.removeListener("query-session-end", onSessionEnd);
    window.removeListener("session-end", onSessionEnd);
  };
}

export interface UpdateLifecycleLike {
  on(event: "before-quit-for-update", listener: () => void): void;
  removeListener(event: "before-quit-for-update", listener: () => void): void;
}

/**
 * 更新安装的防御性兜底：绕过更新 IPC 的路径直接触发 quitAndInstall 时，
 * electron-updater 会先发出 before-quit-for-update —— 此时进入同一个幂等协调器，
 * 让清理与安装仍按受控退出顺序执行。
 */
export function installUpdateShutdownFallback(input: {
  updater: UpdateLifecycleLike;
  coordinator: ShutdownCoordinator;
  finalAction(): void;
}): () => void {
  const { updater, coordinator, finalAction } = input;
  const onBeforeQuitForUpdate = () => {
    if (coordinator.isStopping()) return;
    void coordinator.requestControlledShutdown({
      reason: "update-install",
      finalAction,
    });
  };
  updater.on("before-quit-for-update", onBeforeQuitForUpdate);
  return () => {
    updater.removeListener("before-quit-for-update", onBeforeQuitForUpdate);
  };
}
