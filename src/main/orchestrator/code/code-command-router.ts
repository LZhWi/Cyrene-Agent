/**
 * CodeCommandRouter - 本地命令路由
 *
 * /compact: 当前 Cline SDK 不支持 manual compact，返回降级提示
 * /context: 显示 token 用量 + provider + model
 * /newtask: 创建新 Cline Task
 * /mode: 切换 Plan/Act
 */

import * as chatsStore from "../../chats/chats-store";
import { clineRuntime } from "./cline-runtime-manager";
import type { ChatSession } from "../../../shared/chat-types";

export type CommandResult =
  | { type: "info"; message: string }
  | { type: "newtask"; sessionId: string; taskTitle?: string }
  | { type: "mode"; clineMode: "plan" | "act" }
  | { type: "error"; message: string }
  | { type: "unknown" };

/**
 * 解析并执行本地命令
 */
export async function routeCommand(
  text: string,
  session: ChatSession,
): Promise<CommandResult> {
  const trimmed = text.trim();

  if (trimmed === "/compact") {
    return {
      type: "info",
      message: "当前 Cline SDK 0.0.66 不支持手动压缩。Auto Compact 已启用（阈值 90%）。" +
               "等待 SDK 后续版本支持 manual compact 接口。",
    };
  }

  if (trimmed === "/context") {
    const clineSessionId = session.codeSession?.activeClineSessionId;
    if (!clineSessionId) {
      return { type: "info", message: "当前无活跃 Cline Session。" };
    }
    try {
      const usage: any = await clineRuntime.getAccumulatedUsage?.(clineSessionId);
      const lines = [
        `Provider: (待确认)`,
        `Model: (待确认)`,
        `上下文窗口: (待确认) Token`,
        `累计 Token 用量: ${usage?.inputTokens ?? "?"} input / ${usage?.outputTokens ?? "?"} output`,
        `累计费用: $${usage?.totalCost ?? "?"}`,
        `Compact 模式: Auto (basic, 阈值 90%)`,
        `Cline Session: ${clineSessionId}`,
        "",
        "注：累计用量不等同于当前上下文窗口占用率。",
      ];
      return { type: "info", message: lines.join("\n") };
    } catch (err) {
      return { type: "error", message: `获取上下文失败：${(err as Error).message}` };
    }
  }

  if (trimmed === "/newtask") {
    const oldSessionId = session.codeSession?.activeClineSessionId;
    if (oldSessionId) {
      try {
        await clineRuntime.stop(oldSessionId);
      } catch { /* ignore */ }
    }
    // 新 Task 由 caller 处理：调用 createNewTask
    return {
      type: "newtask",
      sessionId: oldSessionId ?? "", // 占位，实际 sessionId 由 code-session-manager 生成
      taskTitle: "New Task",
    };
  }

  if (trimmed.startsWith("/mode")) {
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
      return { type: "error", message: "用法: /mode plan | /mode act" };
    }
    const mode = parts[1].toLowerCase();
    if (mode !== "plan" && mode !== "act") {
      return { type: "error", message: "mode 必须是 plan 或 act" };
    }
    return { type: "mode", clineMode: mode };
  }

  return { type: "unknown" };
}

/**
 * 更新会话的 clineMode
 */
export function updateSessionClineMode(
  sessionId: string,
  clineMode: "plan" | "act",
): void {
  const session = chatsStore.getSession(sessionId);
  if (!session || !session.codeSession) return;
  session.codeSession.clineMode = clineMode;
  // 注意：实际持久化需要 chatsStore 提供 updateCodeSession 方法
  // 这里仅更新内存中的对象，持久化留给后续 commit
}