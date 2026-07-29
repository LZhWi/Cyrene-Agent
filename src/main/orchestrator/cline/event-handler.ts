/**
 * Cline 适配层 - 事件流处理器
 *
 * 有状态流处理：
 * - 只选 agent_event 作为正文来源，忽略 chunk 事件
 * - 连续 content_start 不重复创建 text_message
 * - reasoning/text 交错时独立维护 textMessageOpen
 * - <think> 使用跨 chunk 状态过滤
 * - 保守标记 hasPotentialSideEffects
 */

import type { CoreSessionEvent } from "@cline/core";
import type { StreamState, ToolCallRecord, CommandRecord } from "./types";
import { ThinkFilter } from "./think-filter";
import { isWithinWorkspace } from "./workspace-guard";
import { checkCommands } from "./command-guard";
import * as path from "path";

export interface StreamEventEmitter {
  (event: {
    type: "text_message_start" | "text_message_content" | "text_message_end"
      | "tool_call_start" | "tool_call_end" | "step_progress";
    messageId?: string;
    delta?: string;
    toolCallId?: string;
    toolCallName?: string;
    stepName?: string;
  }): void;
}

export function createStreamState(workspaceRoot: string): StreamState {
  return {
    workspaceRoot,
    currentMessageId: null,
    currentContentType: null,
    textMessageOpen: false,
    thinkFilter: { insideThink: false, buffer: "" },
    toolCalls: new Map(),
    changedFiles: new Set(),
    commands: [],
    iterationCount: 0,
    hasPotentialSideEffects: false,
    summary: "",
    usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 },
  };
}

/**
 * 处理 Cline 事件，映射到 Cyrene AG-UI 事件。
 */
export function handleClineEvent(
  event: CoreSessionEvent,
  state: StreamState,
  thinkFilter: ThinkFilter,
  emit: StreamEventEmitter,
  workspaceRoot: string,
  allowedCommands?: import("./types").CommandAllowList,
): void {
  if (event.type === "agent_event") {
    handleAgentEvent(event.payload.event as any, state, thinkFilter, emit, workspaceRoot, allowedCommands);
  } else if (event.type === "pending_prompts") {
    // Ask 用户交互由 delegateCoding 主函数处理
  } else if (event.type === "status") {
    // 内部记录，不发送到 AG-UI
  } else if (event.type === "ended") {
    // 会话结束，关闭未完成的 text message
    if (state.textMessageOpen && state.currentMessageId) {
      const remaining = thinkFilter.flush();
      if (remaining) {
        emit({ type: "text_message_content", messageId: state.currentMessageId, delta: remaining });
      }
      emit({ type: "text_message_end", messageId: state.currentMessageId });
      state.textMessageOpen = false;
    }
  }
  // 忽略 chunk 事件（避免与 agent_event 重复）
}

function handleAgentEvent(
  ae: any,
  state: StreamState,
  thinkFilter: ThinkFilter,
  emit: StreamEventEmitter,
  workspaceRoot: string,
  allowedCommands?: import("./types").CommandAllowList,
): void {
  const innerType = ae?.type;
  const ct = ae?.contentType;

  if (innerType === "content_start") {
    if (ct === "text") {
      // 不重复创建 text message（如果已经打开就继续用）
      if (!state.textMessageOpen) {
        state.currentMessageId = `cline-msg-${Date.now()}`;
        state.textMessageOpen = true;
        emit({ type: "text_message_start", messageId: state.currentMessageId });
      }
      state.currentContentType = "text";
      // 处理初始文本
      if (ae.text) {
        const filtered = thinkFilter.process(ae.text);
        if (filtered && state.currentMessageId) {
          emit({ type: "text_message_content", messageId: state.currentMessageId, delta: filtered });
        }
      }
    } else if (ct === "reasoning") {
      // reasoning 不发送到用户
      state.currentContentType = "reasoning";
    } else if (ct === "tool") {
      state.currentContentType = "tool";
      const toolCallId = ae.toolCallId || `tool-${Date.now()}`;
      const record: ToolCallRecord = {
        toolName: ae.toolName || "unknown",
        toolCallId,
        input: ae.input,
        startedAt: Date.now(),
      };
      state.toolCalls.set(toolCallId, record);
      emit({ type: "tool_call_start", toolCallId, toolCallName: ae.toolName });
    }
  } else if (innerType === "content_end") {
    if (ct === "text" && state.textMessageOpen && state.currentMessageId) {
      // 处理剩余文本
      if (ae.text) {
        const filtered = thinkFilter.process(ae.text);
        if (filtered) {
          emit({ type: "text_message_content", messageId: state.currentMessageId, delta: filtered });
        }
      }
      // 不关闭 text message，可能后续还有 content_start (text)
      // 只在 ended 事件或 reasoning 切换时关闭
    } else if (ct === "tool") {
      const toolCallId = ae.toolCallId;
      const record = state.toolCalls.get(toolCallId);
      if (record) {
        record.output = ae.output;
        record.error = ae.error;
        record.durationMs = ae.durationMs;

        // 收集副作用（保守标记）
        collectSideEffects(record, state, workspaceRoot, allowedCommands);
      }
      emit({ type: "tool_call_end", toolCallId });
    }
  } else if (innerType === "iteration_end") {
    state.iterationCount = ae.iteration || state.iterationCount + 1;
    emit({ type: "step_progress", stepName: `iteration-${state.iterationCount}` });
  } else if (innerType === "done") {
    // 关闭未完成的 text message
    if (state.textMessageOpen && state.currentMessageId) {
      const remaining = thinkFilter.flush();
      if (remaining) {
        emit({ type: "text_message_content", messageId: state.currentMessageId, delta: remaining });
      }
      emit({ type: "text_message_end", messageId: state.currentMessageId });
      state.textMessageOpen = false;
    }
    // 提取最终摘要
    if (ae.text) state.summary = ae.text;
  } else if (innerType === "error") {
    state.summary = String(ae.error || ae.message || "Agent error");
  } else if (innerType === "usage") {
    state.usage.inputTokens += ae.inputTokens || 0;
    state.usage.outputTokens += ae.outputTokens || 0;
  }
}

/**
 * 收集副作用：
 * - editor/apply_patch 获得执行批准时标记 hasPotentialSideEffects
 * - run_commands 获得执行批准时标记 hasPotentialSideEffects
 * - 文件修改记录 changedFiles
 * - 命令执行记录 commands
 */
function collectSideEffects(
  record: ToolCallRecord,
  state: StreamState,
  workspaceRoot: string,
  allowedCommands?: import("./types").CommandAllowList,
): void {
  if (record.toolName === "editor" || record.toolName === "apply_patch") {
    // 保守标记（不需要等成功结束）
    state.hasPotentialSideEffects = true;

    // 收集变更文件
    const filePath = extractFilePath(record.input);
    if (filePath && isWithinWorkspace(filePath, workspaceRoot)) {
      state.changedFiles.add(path.normalize(filePath));
    }
  }

  if (record.toolName === "run_commands") {
    // 保守标记
    state.hasPotentialSideEffects = true;

    // 收集命令记录
    const input = record.input as any;
    if (Array.isArray(input?.commands)) {
      for (const cmd of input.commands) {
        const cmdStr = typeof cmd === "string" ? cmd : String(cmd?.command || "") + " " + (Array.isArray(cmd?.args) ? cmd.args.join(" ") : "");
        const exitCode = extractExitCode(record.output);
        const stdout = extractStdout(record.output);
        const stderr = extractStderr(record.output);
        const cmdRecord: CommandRecord = { command: cmdStr, exitCode, stdout, stderr };
        state.commands.push(cmdRecord);

        // 验证结果
        if (cmdStr.includes("tsc")) {
          // 已经在 state 中记录
        }
      }
    }
  }
}

function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  return String(obj.path || obj.filePath || obj.file_path || "") || null;
}

function extractExitCode(output: unknown): number | null {
  if (!output || typeof output !== "object") return null;
  const obj = output as Record<string, unknown>;
  if (typeof obj.exitCode === "number") return obj.exitCode;
  if (typeof obj.exit_code === "number") return obj.exit_code;
  if (typeof obj.code === "number") return obj.code;
  return null;
}

function extractStdout(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const obj = output as Record<string, unknown>;
  return typeof obj.stdout === "string" ? obj.stdout : undefined;
}

function extractStderr(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const obj = output as Record<string, unknown>;
  return typeof obj.stderr === "string" ? obj.stderr : undefined;
}

/**
 * 从 StreamState 构建验证结果。
 */
export function buildVerification(state: StreamState): import("./types").VerificationResult {
  const tscCommand = state.commands.find(c => c.command.includes("tsc"));
  if (!tscCommand) {
    return { attempted: false, passed: false };
  }
  return {
    attempted: true,
    passed: tscCommand.exitCode === 0,
    details: tscCommand.stderr || tscCommand.stdout || undefined,
  };
}
