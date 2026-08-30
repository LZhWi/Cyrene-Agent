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
