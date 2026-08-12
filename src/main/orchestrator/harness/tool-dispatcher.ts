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
import { isHarnessBuiltin, isInteractiveHarnessBuiltin } from "./builtin-tools";
import { executeUpdateTodo, executeAskUser, executeTask } from "./builtin-tools";
import { resolveSideEffect } from "./side-effect-resolver";
import { isBlockedByUncertainEffect } from "./uncertain-effect-guard";
import { ExecutionLedger } from "../execution-ledger";
import type { ToolExecutionOutcome } from "../types";

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
  includeInteractiveTools?: boolean;
  checkPermission?: (toolId: string, args: Record<string, unknown>) => Promise<boolean>;
  toolContext?: import("../tool-context").ToolContext;
  truncation?: TruncationConfig;
  executionLedger?: ExecutionLedger;
  taskExecutor?: import("../task-runtime").TaskExecuteRequest extends infer _T ? (request: import("../task-runtime").TaskExecuteRequest) => Promise<import("../task-runtime").TaskExecuteResult> : never;
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
    if (ctx.includeInteractiveTools === false && isInteractiveHarnessBuiltin(call.name)) {
      return {
        outcome: "failure",
        category: "not_found",
        tool: call.name,
        message: "当前渠道不支持交互式工具",
      };
    }
  }

  // ── 普通工具 ──
  const args = parseToolCallArgs(call);
  const tool = ctx.tools.find((t) => t.id === call.name);

  // fingerprint 拦截（v3 §5.5.1.1）
  const fingerprint = toolCallFingerprint(call.name, args);
  if (isBlockedByUncertainEffect(ctx.state, fingerprint)) {
    return {
      outcome: "failure",
      category: "runtime_safety",
      tool: call.name,
      message:
        "该副作用已有一次未确认结果，在 reconcile 或 ask 用户前不能重复执行",
    };
  }

  // 工具不存在
  if (!tool) {
    return {
      outcome: "failure",
      category: "not_found",
      tool: call.name,
      message: `工具 "${call.name}" 未注册`,
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

  let result: ToolCallResult | undefined;
  // 提取 targetRefs 从 args（path / file / url / id 等常见字段）
  const targetRefs = args.path !== undefined ? [String(args.path)]
    : args.file !== undefined ? [String(args.file)]
    : args.url !== undefined ? [String(args.url)]
    : [];

  // ExecutionLedger 命中 → 直接返回缓存的终态成功结果
  if (ctx.executionLedger) {
    try {
      const ledgerRun = async (): Promise<ToolExecutionOutcome> => {
        const run = await (async (): Promise<ToolCallResult> => {
          try {
            const output = await tool.execute(args, ctx.toolContext);
            return {
              toolId: tool.id,
              args,
              output,
              status: "succeeded",
              terminal: true,
              retryable: false,
            };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return {
              toolId: tool.id,
              args,
              output: errorMsg,
              status: "failed",
              errorCode: "TOOL_EXECUTION_ERROR",
              terminal: true,
              retryable: false,
            };
          }
        })();
        return {
          status: run.status === "succeeded" ? "succeeded" : "failed",
          output: run.output,
          terminal: run.terminal,
          retryable: run.retryable,
          errorCode: run.errorCode,
        };
      };

      const ledgerResult = await ctx.executionLedger.execute(
        { logicalInvocationId: `${ctx.toolContext?.runId ?? "unknown"}:${call.id}`, capability: tool.id, targetRefs, args },
        ledgerRun,
      );

      if (ledgerResult.cached) {
        // 命中缓存：构造 cached observation
        const cached = ledgerResult.outcome;
        const cachedPreview = (cached.output ?? "").toString().slice(0, 200);
        ctx.onEvent?.({
          type: "tool_end",
          toolCallId: call.id,
          outcome: cached.status === "succeeded" ? "success" : "failure",
          preview: `[cached] ${cachedPreview}`,
        });
        return {
          outcome: cached.status === "succeeded" ? "success" : "failure",
          tool: call.name,
          target: targetRefs[0],
          message: cached.output ?? "(cached)",
          output: cached.output,
          truncated: false,
          fullOutputRef: undefined,
        };
      }

      // 未命中：把 ledger 跑出来的结果赋给 result
      result = ledgerResult.outcome.status === "succeeded"
        ? {
            toolId: tool.id,
            args,
            output: ledgerResult.outcome.output,
            status: "succeeded",
            terminal: ledgerResult.outcome.terminal,
            retryable: ledgerResult.outcome.retryable,
          }
        : {
            toolId: tool.id,
            args,
            output: ledgerResult.outcome.output ?? "(no output)",
            status: "failed",
            errorCode: ledgerResult.outcome.errorCode ?? "TOOL_EXECUTION_ERROR",
            terminal: ledgerResult.outcome.terminal,
            retryable: ledgerResult.outcome.retryable,
          };
    } catch {
      // ledger 自身出错(不太可能) → 退回到下面直接执行,result 仍是 ToolCallResult | undefined
    }
  }

  // 如果 ledger 路径已填 result,跳过下面的直接执行
  if (!result) {
    try {
      const output = await tool.execute(args, ctx.toolContext);
      result = {
        toolId: tool.id,
        args,
        output,
        status: "succeeded",
        terminal: true,
        retryable: false,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result = {
        toolId: tool.id,
        args,
        output: errorMsg,
        status: "failed",
        errorCode: "TOOL_EXECUTION_ERROR",
        terminal: true,
        retryable: false,
      };
    }
  }

  // 截断输出（v3 §5.7）
  const truncationConfig = ctx.truncation ?? DEFAULT_TRUNCATION;
  const sideEffect = resolveSideEffect(tool, args);
  const { preview, truncated, fullOutputRef } = truncateOutput(
    result.output,
    truncationConfig,
    call.id,
  );

  ctx.onEvent?.({
    type: "tool_end",
    toolCallId: call.id,
    outcome: result.status === "succeeded" ? "success" : "failure",
    preview: preview.slice(0, 200),
  });

  // 构造 observation
  const outcome: ToolObservation["outcome"] =
    result.status === "succeeded" ? "success" : "failure";

  return {
    outcome,
    tool: call.name,
    target: (args.path as string | undefined) ?? (args.command as string | undefined) ?? (args.query as string | undefined),
    message: preview,
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
    case "task":
      return executeTask(call, ctx.taskExecutor);

    default:
      return {
        outcome: "failure",
        category: "not_found",
        tool: call.name,
        message: `未知的 Harness 内置工具: ${call.name}`,
      };
  }
}
