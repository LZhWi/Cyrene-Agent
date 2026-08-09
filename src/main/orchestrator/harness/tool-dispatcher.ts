/**
 * 工具分发器（v3 §3.1 / §5.7）
 *
 * 统一 dispatch Harness 内置工具和普通工具。
 * - 内置工具（update_todo / ask_user）：由 executeHarnessBuiltin 处理，能直接访问 state 和 emitter
 * - 普通工具：走 executeToolCall，含权限检查、预校验、输出截断
 *
 * 普通工具执行前检查 uncertainEffects fingerprint 拦截（v3 §5.5.1.1）。
 * 普通工具执行后统一截断输出（v3 §5.7 双级预算）。
 */

import type { ToolCall } from "../vendors/types";
import type { ToolDefinition } from "../tool-registry";
import type { ToolCallResult } from "../types";
import type { AgentState, HarnessEvent, ToolObservation } from "./types";
import { parseToolCallArgs, toolCallFingerprint } from "./types";
import { isHarnessBuiltin } from "./builtin-tools";
import {
  executeUpdateTodo,
  executeAskUser,
  executeConfirmUncertainEffect,
} from "./builtin-tools";
import { resolveSideEffect } from "./side-effect-resolver";
import { evaluateUncertainEffect } from "./uncertain-effect-guard";
import { ExecutionLedger } from "../execution-ledger";
import type { ToolExecutionOutcome } from "../types";
import { executeToolDefinition } from "../tool-executor";
import { classifyToolResultError } from "./error-classifier";

// ── 工具输出截断（v3 §5.7）───────────────────────────────

export interface TruncationConfig {
  softLimit: number;
  hardLimit: number;
}

export const DEFAULT_TRUNCATION: TruncationConfig = {
  softLimit: 2000,
  hardLimit: 8000,
};

/**
 * 截断工具输出（v3 §5.7 双级预算）。
 * - 软截断：超过 softLimit 截断，返回 preview
 * - 硬熔断：超过 hardLimit 强制砍到 hardLimit
 */
export function truncateOutput(
  output: string,
  config: TruncationConfig,
  toolCallId: string,
): { preview: string; truncated: boolean; fullOutputRef?: string } {
  if (output.length <= config.softLimit) {
    return { preview: output, truncated: false };
  }

  const truncated = true;
  const hardCapped = output.length > config.hardLimit
    ? output.slice(0, config.hardLimit) + `\n...[硬熔断，原长度 ${output.length}]`
    : output;

  // P0: 暂不实现 backing store，fullOutputRef 省略
  // P1: 如果有 ToolOutputStore，保存完整输出并返回引用
  const preview = hardCapped.slice(0, config.softLimit) + `\n...[已截断，原长度 ${output.length} 字符]`;

  return { preview, truncated, fullOutputRef: undefined };
}

// ── 工具执行接口 ─────────────────────────────────────────

export interface ToolDispatchContext {
  state: AgentState;
  tools: ToolDefinition[];
  onEvent?: (event: HarnessEvent) => void;
  requestUserClarification?: (card: unknown) => Promise<unknown>;
  checkPermission?: (toolId: string, args: Record<string, unknown>) => Promise<boolean>;
  toolContext?: import("../tool-context").ToolContext;
  truncation?: TruncationConfig;
  executionLedger?: ExecutionLedger;
}

export interface ToolDispatchResult extends ToolObservation {
  /** 原始工具执行结果（如果有） */
  rawResult?: ToolCallResult;
}

/**
 * 统一 dispatch 工具调用（v3 §3.1）。
 *
 * 1. 内置工具 → executeHarnessBuiltin
 * 2. 普通工具 → 先检查 fingerprint 拦截 → executeToolCall → 截断输出
 */
export async function dispatchToolCall(
  call: ToolCall,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  // ── 内置工具 ──
  if (isHarnessBuiltin(call.name)) {
    return executeHarnessBuiltin(call, ctx);
  }

  // ── 普通工具 ──
  const args = parseToolCallArgs(call);
  const tool = ctx.tools.find((t) => t.id === call.name);

  // 工具不存在
  if (!tool) {
    return {
      outcome: "failure",
      category: "not_found",
      tool: call.name,
      message: `工具 "${call.name}" 未注册`,
    };
  }

  const sideEffect = resolveSideEffect(tool, args);
  const fingerprint = toolCallFingerprint(call.name, args);
  const uncertainDecision = evaluateUncertainEffect(ctx.state, fingerprint, sideEffect);
  if (!uncertainDecision.allowed) {
    return {
      outcome: "not_executed",
      category: "runtime_safety",
      toolSideEffect: sideEffect,
      tool: call.name,
      message: uncertainDecision.message,
      suggestion: "查证前一次结果、请求用户明确确认，或诚实结束",
    };
  }

  // 权限检查
  if (ctx.checkPermission) {
    const allowed = await ctx.checkPermission(tool.id, args);
    if (!allowed) {
      return {
        outcome: "failure",
        category: "permission_denied",
        tool: call.name,
        message: `工具 "${tool.id}" 被权限系统拒绝`,
      };
    }
  }

  // 执行工具
  ctx.onEvent?.({
    type: "tool_start",
    toolCallId: call.id,
    toolName: call.name,
    args,
  });

  let execution: ToolExecutionOutcome;
  let deduplicated = false;
  // 提取 targetRefs 从 args（path / file / url / id 等常见字段）
  const targetRefs = args.path !== undefined ? [String(args.path)]
    : args.file !== undefined ? [String(args.file)]
    : args.url !== undefined ? [String(args.url)]
    : [];

  const runTool = () => executeToolDefinition(tool, args, ctx.toolContext);

  // ExecutionLedger 只 replay 同一个 logical invocation 的终态成功事实。
  if (ctx.executionLedger) {
    const ledgerResult = await ctx.executionLedger.execute({
      logicalInvocationId: `${ctx.toolContext?.runId ?? "unknown-run"}:${call.id}`,
      capability: tool.id,
      targetRefs,
      args,
    }, runTool);
    execution = ledgerResult.outcome;
    deduplicated = ledgerResult.cached;
  } else {
    execution = await runTool();
  }

  const result: ToolCallResult = {
    toolId: tool.id,
    args,
    output: execution.output,
    status: execution.status,
    errorCode: execution.errorCode,
    category: execution.category,
    effectState: execution.effectState,
    terminal: execution.terminal,
    retryable: execution.retryable,
    ...(deduplicated ? { deduplicated: true } : {}),
  };

  const category = result.status === "failed"
    ? result.category ?? classifyToolResultError(result)
    : undefined;
  const observationOutcome: ToolObservation["outcome"] = result.status === "succeeded"
    ? "success"
    : sideEffect === "non_idempotent_side_effect"
      && (result.effectState === "unknown" || category === "timeout")
      ? "unknown"
      : "failure";

  if (observationOutcome === "unknown") {
    const effectId = `${ctx.toolContext?.runId ?? "unknown-run"}:${call.id}`;
    if (!ctx.state.uncertainEffects.some((effect) => effect.id === effectId)) {
      ctx.state.uncertainEffects.push({
        id: effectId,
        toolCallId: call.id,
        fingerprint,
        toolName: call.name,
        message: result.output,
      });
    }
  }

  // 截断输出（v3 §5.7）
  const truncationConfig = ctx.truncation ?? DEFAULT_TRUNCATION;
  const { preview, truncated, fullOutputRef } = truncateOutput(
    result.output,
    truncationConfig,
    call.id,
  );

  ctx.onEvent?.({
    type: "tool_end",
    toolCallId: call.id,
    outcome: observationOutcome === "success" ? "success" : "failure",
    preview: `${deduplicated ? "[replayed] " : ""}${preview.slice(0, 200)}`,
  });

  return {
    outcome: observationOutcome,
    category,
    toolSideEffect: sideEffect,
    tool: call.name,
    target: (args.path as string | undefined) ?? (args.command as string | undefined) ?? (args.query as string | undefined),
    message: `${deduplicated ? "[replayed] " : ""}${preview}`,
    output: result.output,
    truncated,
    preview,
    fullOutputRef,
    rawResult: result,
  };
}

// ── 内置工具执行 ─────────────────────────────────────────

async function executeHarnessBuiltin(
  call: ToolCall,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchResult> {
  switch (call.name) {
    case "update_todo":
      return executeUpdateTodo(call, ctx.state, ctx.onEvent);

    case "ask_user":
      return executeAskUser(call, ctx.requestUserClarification, ctx.onEvent);

    case "confirm_uncertain_effect":
      return executeConfirmUncertainEffect(call, ctx.state, ctx.requestUserClarification);

    default:
      return {
        outcome: "failure",
        category: "not_found",
        tool: call.name,
        message: `未知的 Harness 内置工具: ${call.name}`,
      };
  }
}
