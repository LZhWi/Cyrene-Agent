/**
 * CodeSessionManager - Session 映射 + Task 历史 + CodeTaskRecovery
 *
 * 职责：
 * - 维护 activeClineSessionId 与 ChatSession 的映射
 * - Task 历史记录（含 recovery 链）
 * - 无副作用 Session 恢复
 */

import type { ChatSession, ConversationWorkspaceBinding } from "../../../shared/chat-types";
import { clineRuntime } from "./cline-runtime-manager";

export type RecoveryMode = "active_session" | "message_reconstruction" | "fresh_session";

export interface CodeTaskRecovery {
  recoveryMode: RecoveryMode;
  recoveredFromSessionId?: string;
  recoveredAt?: number;
  lostRuntimeState: boolean;
  droppedTrailingMessages?: number;
  interruptedTurnDetected?: boolean;
}

export interface CodeTaskRecord {
  clineSessionId: string;
  createdAt: number;
  closedAt?: number;
  title?: string;
  recovery?: CodeTaskRecovery;
}

export interface SessionReconstructionResult {
  messages: unknown[];
  droppedTrailingMessages: number;
  interruptedTurnDetected: boolean;
  unresolvedToolCalls: string[];
}

/**
 * 重建 Session 消息：截断悬空工具调用和未配对的 ToolResult
 */
export function reconstructSessionMessages(rawMessages: any[]): SessionReconstructionResult {
  if (rawMessages.length === 0) {
    return { messages: [], droppedTrailingMessages: 0, interruptedTurnDetected: false, unresolvedToolCalls: [] };
  }

  const messages = [...rawMessages];
  let droppedTrailingMessages = 0;
  let interruptedTurnDetected = false;
  const unresolvedToolCalls: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = msg?.content;

    // 字符串 content 默认完整
    if (typeof content === "string") break;

    // 数组 content 检查每个 block
    if (Array.isArray(content)) {
      const toolUses: { id: string; name: string }[] = [];
      const toolResults: { toolUseId: string }[] = [];
      let hasIncompleteBlock = false;

      for (const block of content) {
        const b = block as { type?: string; id?: string; name?: string; tool_use_id?: string };
        if (b.type === "tool_use") {
          toolUses.push({ id: b.id!, name: b.name! });
        } else if (b.type === "tool_result") {
          toolResults.push({ toolUseId: b.tool_use_id! });
        } else if (b.type === "text" || b.type === "thinking") {
          // 完整 block
        } else {
          hasIncompleteBlock = true;
        }
      }

      // 检查是否有未配对的 tool_use
      const resultIds = new Set(toolResults.map(r => r.toolUseId));
      const unmatched = toolUses.filter(tu => !resultIds.has(tu.id));

      if (hasIncompleteBlock || unmatched.length > 0) {
        interruptedTurnDetected = true;
        unresolvedToolCalls.push(...unmatched.map(u => u.id));
        // 截断
        const cutIndex = i;
        droppedTrailingMessages = messages.length - cutIndex;
        messages.length = cutIndex;
        break;
      }

      break;
    }

    break;
  }

  return { messages, droppedTrailingMessages, interruptedTurnDetected, unresolvedToolCalls };
}

/**
 * 获取或创建 Cline Session
 *
 * 恢复策略：
 * 1. activeSessionId 在 Runtime 内存中活跃 -> 直接 send
 * 2. 仅磁盘存在 -> readMessages + start(initialMessages) 重建
 * 3. 都不存在 -> start() 新建
 */
export async function getOrCreateClineSession(
  session: ChatSession,
  userMessage: string,
  config: Record<string, unknown>,
): Promise<{ sessionId: string; recovery: CodeTaskRecovery }> {
  const oldSessionId = session.codeSession?.activeClineSessionId;
  const workspaceRoot = session.workspaceBinding?.workspaceRoot;

  // 情况 1: 旧 Session 在内存中活跃
  if (oldSessionId && clineRuntime.isSessionActive(oldSessionId)) {
    return {
      sessionId: oldSessionId,
      recovery: {
        recoveryMode: "active_session",
        recoveredFromSessionId: oldSessionId,
        recoveredAt: Date.now(),
        lostRuntimeState: false,
      },
    };
  }

  // 情况 2: 旧 Session 仅在磁盘上
  if (oldSessionId && workspaceRoot) {
    try {
      const rawMessages = await clineRuntime.readMessages(oldSessionId);
      if (rawMessages && rawMessages.length > 0) {
        const reconstruction = reconstructSessionMessages(rawMessages);

        const result = await clineRuntime.start({
          config,
          initialMessages: reconstruction.messages,
          interactive: true,
        });
        if (result.sessionId) {
          return {
            sessionId: result.sessionId,
            recovery: {
              recoveryMode: "message_reconstruction",
              recoveredFromSessionId: oldSessionId,
              recoveredAt: Date.now(),
              lostRuntimeState: true,
              droppedTrailingMessages: reconstruction.droppedTrailingMessages,
              interruptedTurnDetected: reconstruction.interruptedTurnDetected,
            },
          };
        }
      }
    } catch (err) {
      console.warn("[CodeSession] readMessages failed:", err);
    }
  }

  // 情况 3: 从零创建
  const result = await clineRuntime.start({
    config,
    prompt: userMessage,
    interactive: true,
  });
  if (!result.sessionId) {
    throw new Error("Failed to create new session");
  }
  return {
    sessionId: result.sessionId,
    recovery: {
      recoveryMode: "fresh_session",
      recoveredAt: Date.now(),
      lostRuntimeState: true,
    },
  };
}

/**
 * 创建新的 Cline Task（/newtask）
 */
export async function createNewTask(
  session: ChatSession,
  workspaceBinding: ConversationWorkspaceBinding,
  config: Record<string, unknown>,
): Promise<{ sessionId: string; recovery: CodeTaskRecovery }> {
  const result = await clineRuntime.start({
    config,
    interactive: true,
  });
  if (!result.sessionId) {
    throw new Error("Failed to create new task");
  }
  return {
    sessionId: result.sessionId,
    recovery: {
      recoveryMode: "fresh_session",
      recoveredAt: Date.now(),
      lostRuntimeState: true,
    },
  };
}