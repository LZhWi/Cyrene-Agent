import type { ToolCall } from "../vendors/types";
import { resolveEffectKind, type ToolDefinition } from "../tool-registry";
import { parseToolCallArgs } from "./types";
import { resolveSideEffect } from "./side-effect-resolver";
import { isHarnessBuiltin } from "./builtin-tools";
import { READ_TOOL_RESULT_TOOL_ID } from "./tool-output/read-tool-result";

export type ToolExecutionMode = "parallel" | "exclusive";

export type ToolScheduleCommitDecision = "continue" | "halt";

/** 原始模型调用顺序的显式载体；完成顺序不得替代该顺序。 */
export interface ToolCallExecution {
  toolCallIndex: number;
  call: ToolCall;
}

export interface ToolCallSchedulerOptions<T> {
  calls: ToolCall[];
  maxParallel: number;
  signal?: AbortSignal;
  classify: (call: ToolCall) => ToolExecutionMode;
  execute: (execution: ToolCallExecution) => Promise<T>;
  commit: (execution: ToolCallExecution, result: T) => Promise<ToolScheduleCommitDecision>;
  notExecuted: (execution: ToolCallExecution, reason: string) => Promise<T>;
}

export interface ToolCallScheduleResult {
  cancelled: boolean;
  halted: boolean;
}

/**
 * 并发默认拒绝：普通工具必须显式声明当前参数安全，且只能是读操作。
 * Harness 内置工具中仅 read_tool_result 不会改父状态，允许并发。
 */
export function classifyToolExecutionMode(
  call: ToolCall,
  tools: ToolDefinition[],
): ToolExecutionMode {
  if (isHarnessBuiltin(call.name)) {
    return call.name === READ_TOOL_RESULT_TOOL_ID ? "parallel" : "exclusive";
  }

  const tool = tools.find((candidate) => candidate.id === call.name);
  if (!tool) return "exclusive";

  const args = parseToolCallArgs(call);
  try {
    const effectKind = resolveEffectKind(tool, args);
    if (effectKind !== "read" && effectKind !== "verification") return "exclusive";
    if (resolveSideEffect(tool, args) !== "read_only") return "exclusive";
  } catch {
    return "exclusive";
  }

  try {
    return tool.isConcurrencySafe?.(args) === true ? "parallel" : "exclusive";
  } catch {
    return "exclusive";
  }
}

/**
 * 按模型顺序调度工具：连续安全调用使用滚动池；独占调用前后形成屏障。
 * 完成顺序不影响 commit 顺序，因此模型消息和 Harness 状态可保持稳定。
 */
export async function scheduleToolCalls<T>(
  options: ToolCallSchedulerOptions<T>,
): Promise<ToolCallScheduleResult> {
  const maxParallel = Math.max(1, Math.trunc(options.maxParallel) || 1);
  let index = 0;
  const executionAt = (toolCallIndex: number): ToolCallExecution => ({
    toolCallIndex,
    call: options.calls[toolCallIndex]!,
  });

  const commitNotStarted = async (from: number, reason: string): Promise<void> => {
    for (let cursor = from; cursor < options.calls.length; cursor++) {
      const execution = executionAt(cursor);
      const result = await options.notExecuted(execution, reason);
      await options.commit(execution, result);
    }
  };

  while (index < options.calls.length) {
    if (options.signal?.aborted) {
      await commitNotStarted(index, "aborted_before_dispatch");
      return { cancelled: true, halted: false };
    }

    const first = options.calls[index];
    if (options.classify(first) === "exclusive") {
      const execution = executionAt(index);
      const result = await options.execute(execution);
      const decision = await options.commit(execution, result);
      index++;
      if (decision === "halt") {
        await commitNotStarted(index, "not_executed_after_halt");
        return { cancelled: false, halted: true };
      }
      continue;
    }

    const groupStart = index;
    while (index < options.calls.length && options.classify(options.calls[index]) === "parallel") {
      index++;
    }
    const group = options.calls.slice(groupStart, index).map((call, offset) => ({
      toolCallIndex: groupStart + offset,
      call,
    }));
    const groupResult = await runParallelGroup(group, maxParallel, options);

    if (groupResult.cancelled) {
      await commitNotStarted(groupStart + groupResult.started, "aborted_before_dispatch");
      return { cancelled: true, halted: false };
    }
    if (groupResult.halted) {
      await commitNotStarted(index, "not_executed_after_halt");
      return { cancelled: false, halted: true };
    }
  }

  return { cancelled: false, halted: false };
}

interface ParallelGroupResult {
  started: number;
  cancelled: boolean;
  halted: boolean;
}

async function runParallelGroup<T>(
  calls: ToolCallExecution[],
  maxParallel: number,
  options: ToolCallSchedulerOptions<T>,
): Promise<ParallelGroupResult> {
  type Settled = { index: number; result?: T; error?: unknown };
  const settled: Array<{ ready: boolean; result?: T }> = calls.map(() => ({ ready: false }));
  const active = new Map<number, Promise<Settled>>();
  let launchIndex = 0;
  let commitIndex = 0;
  let halted = false;
  let cancelled = false;

  const launch = (callIndex: number): void => {
    const promise = Promise.resolve()
      .then(() => options.execute(calls[callIndex]!))
      .then(
        (result): Settled => ({ index: callIndex, result }),
        (error): Settled => ({ index: callIndex, error }),
      );
    active.set(callIndex, promise);
  };

  while (launchIndex < calls.length && active.size < maxParallel && !options.signal?.aborted) {
    launch(launchIndex++);
  }

  while (active.size > 0) {
    const next = await Promise.race(active.values());
    active.delete(next.index);
    if (next.error !== undefined) {
      if (options.signal?.aborted) {
        cancelled = true;
        continue;
      }
      throw next.error;
    }
    settled[next.index] = { ready: true, result: next.result };

    if (options.signal?.aborted) {
      cancelled = true;
      continue;
    }

    while (!halted && commitIndex < calls.length && settled[commitIndex].ready) {
      const decision = await options.commit(calls[commitIndex]!, settled[commitIndex].result as T);
      commitIndex++;
      halted = decision === "halt";
    }

    while (!halted && !cancelled && launchIndex < calls.length && active.size < maxParallel && !options.signal?.aborted) {
      launch(launchIndex++);
    }
  }

  return { started: launchIndex, cancelled, halted };
}
