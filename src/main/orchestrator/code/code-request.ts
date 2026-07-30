/**
 * Code 模式请求入口（与 CyreneAgent 平级）
 *
 * Commit 2: stub 实现，返回"开发中"提示。
 * Commit 3 将实现完整 Cline 执行链。
 */

import type { ChatSession } from "../../../shared/chat-types";

export interface CodeRequestContext {
  runId: string;
  sessionId: string;
  signal: AbortSignal;
  emitEvent: (event: unknown) => void;
}

export interface CodeRequestInput {
  text: string;
  sessionId: string;
}

/**
 * Code 模式请求处理（stub）。
 *
 * 完全绕过 CyreneAgent、CITA、WorkLoop。
 * Commit 3 将替换为真实 Cline 执行链。
 */
export async function runCodeRequest(
  input: CodeRequestInput,
  session: ChatSession,
  ctx: CodeRequestContext,
): Promise<void> {
  console.log("[CodeMode] runCodeRequest stub",
    "sessionId=" + ctx.sessionId.slice(0, 8) + "...",
    "mode=" + (session.mode ?? "unknown"),
    "text=" + input.text.slice(0, 50),
  );

  // 发送文本消息事件
  const reply = "Code 模式正在开发中，敬请期待。\n\n当前会话已绑定 Code 模式，完整的 Cline 执行链将在后续版本中接入。";

  ctx.emitEvent({
    type: "text_message_start",
    messageId: `code-${ctx.runId}`,
    role: "assistant",
    runId: ctx.runId,
  });

  // 逐字符发送模拟流式
  for (const char of reply) {
    ctx.emitEvent({
      type: "text_message_content",
      messageId: `code-${ctx.runId}`,
      delta: char,
      runId: ctx.runId,
    });
  }

  ctx.emitEvent({
    type: "text_message_end",
    messageId: `code-${ctx.runId}`,
    runId: ctx.runId,
  });

  // 发送运行结束事件
  ctx.emitEvent({
    type: "run_finished",
    runId: ctx.runId,
    threadId: ctx.sessionId,
  });
}
