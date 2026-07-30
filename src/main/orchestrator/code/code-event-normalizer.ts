/**
 * Cline 事件归一化层
 *
 * 将 SDK CoreSessionEvent 归一化为内部事件类型，
 * 避免 event-handler / ClineResultAdapter / MutationCollector 等模块各自维护一套解析逻辑。
 */

export type NormalizedClineEvent =
  | { type: "file_candidate"; path: string; operation: "create" | "modify" | "delete" | "rename"; toolName: string }
  | { type: "command"; executable: string; args: string[]; exitCode?: number; stdout?: string; stderr?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalCost?: number }
  | { type: "ask"; promptId: string; content: string; options?: string[] }
  | { type: "text_delta"; text: string }
  | { type: "done"; reason: string; summary?: string }
  | { type: "error"; code: string; message: string; recoverable: boolean }
  | { type: "notice"; reason: string; message: string };

/** 将 SDK CoreSessionEvent 转换为 NormalizedClineEvent[] */
export function normalizeClineEvent(event: any): NormalizedClineEvent[] {
  const events: NormalizedClineEvent[] = [];
  const type = event?.type;

  if (type === "chunk") {
    // 忽略原始流式块，由 SDK 聚合后处理
    return [];
  }

  if (type === "agent_event") {
    const ae = event.payload?.event;
    if (!ae) return [];
    return normalizeAgentEvent(ae);
  }

  if (type === "pending_prompts") {
    // pending_prompts 是宿主消息队列，不是 Ask 入口（PoC 1 已确认）
    // Ask 入口是 AskQuestionExecutor，不通过 pending_prompts
    return [];
  }

  if (type === "pending_prompt_submitted") {
    return [];
  }

  if (type === "ended") {
    events.push({
      type: "done",
      reason: event.payload?.reason ?? "unknown",
    });
    return events;
  }

  if (type === "status") {
    return [];
  }

  if (type === "hook") {
    return [];
  }

  if (type === "team_progress") {
    return [];
  }

  if (type === "session_snapshot") {
    return [];
  }

  return [];
}

function normalizeAgentEvent(ae: any): NormalizedClineEvent[] {
  const events: NormalizedClineEvent[] = [];
  const aeType = ae?.type;

  if (aeType === "content_start" || aeType === "content_update") {
    // 文本/思考增量由 caller 单独处理流式输出
    if (ae.contentType === "text" && typeof ae.text === "string") {
      events.push({ type: "text_delta", text: ae.text });
    }
    return events;
  }

  if (aeType === "content_end") {
    if (ae.contentType === "tool") {
      const path = extractToolFilePath(ae);
      const op = extractToolOperation(ae.toolName);
      if (path) {
        events.push({
          type: "file_candidate",
          path,
          operation: op,
          toolName: ae.toolName ?? "unknown",
        });
      }
      if (ae.toolName === "run_commands" || ae.toolName === "bash") {
        const command = ae.input?.command ?? "";
        const parts = command.split(/\s+/);
        events.push({
          type: "command",
          executable: parts[0] ?? "",
          args: parts.slice(1),
        });
      }
    }
    return events;
  }

  if (aeType === "usage") {
    events.push({
      type: "usage",
      inputTokens: ae.totalInputTokens ?? ae.inputTokens ?? 0,
      outputTokens: ae.totalOutputTokens ?? ae.outputTokens ?? 0,
      totalCost: ae.totalCost,
    });
    return events;
  }

  if (aeType === "notice") {
    events.push({
      type: "notice",
      reason: ae.reason ?? "unknown",
      message: ae.message ?? "",
    });
    return events;
  }

  if (aeType === "done") {
    events.push({
      type: "done",
      reason: ae.reason ?? "unknown",
      summary: ae.text,
    });
    return events;
  }

  if (aeType === "error") {
    events.push({
      type: "error",
      code: "CLINE_ERROR",
      message: ae.error?.message ?? "unknown",
      recoverable: ae.recoverable ?? false,
    });
    return events;
  }

  return [];
}

function extractToolFilePath(ae: any): string | null {
  const input = ae.input ?? {};
  return input.path ?? input.filePath ?? input.file_path ?? null;
}

function extractToolOperation(toolName: string): "create" | "modify" | "delete" | "rename" {
  if (toolName === "delete_file" || toolName === "remove") return "delete";
  if (toolName === "rename") return "rename";
  return "modify"; // editor / apply_patch 默认为 modify
}