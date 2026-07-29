/**
 * Cline 适配层 - workspace 锁
 *
 * 防止同一 workspaceRoot 同时运行两个 Cline 会话。
 * 锁 key 保存规范化后的 realRoot，finally 直接按 key 释放。
 */

import { normalizeWorkspaceRoot } from "./workspace-guard";

const activeWorkspaces = new Map<string, string>(); // realRoot -> sessionId

/**
 * 获取 workspace 锁。
 * 抛出错误如果同一 workspaceRoot 已有活跃会话。
 */
export function acquireWorkspaceLock(workspaceRoot: string, sessionId: string): string {
  const realRoot = normalizeWorkspaceRoot(workspaceRoot);
  if (activeWorkspaces.has(realRoot)) {
    throw new Error(`WORKSPACE_LOCKED: ${realRoot} 已有活跃 Cline 会话`);
  }
  activeWorkspaces.set(realRoot, sessionId);
  return realRoot;
}

/**
 * 释放 workspace 锁。
 * 直接按 key 释放，不重新 realpath。
 */
export function releaseWorkspaceLock(lockKey: string): void {
  activeWorkspaces.delete(lockKey);
}
