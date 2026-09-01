/**
 * CyreneHarness ↔ CyreneAgent 适配层
 *
 * 把 CyreneRunOptions 转换为 HarnessInput，运行 Harness，
 * 再把 HarnessEvent 转为 AG-UI BaseEvent，HarnessResult 转为 AgentLoopResult。
 *
 * 设计依据：docs/design/2026-08-08-cyreneHarnessloopdesign.md (v3 §11)
 */

import type { BaseEvent } from "@ag-ui/core";
import { runCyreneHarness } from "./harness";
import type { HarnessEvent, HarnessInput } from "./harness";
import type { AgentLoopResult } from "./cyrene-agent";
import type { CyreneRunOptions, AgentLoopSettings } from "./cyrene-agent";
import type { ToolCallResult } from "./types";
import { mapTerminateReason, mapTerminateReasonToTerminal } from "./harness/adapter/terminal-mapper";
export { mapTerminateReasonToTerminal } from "./harness/adapter/terminal-mapper";
export {
  buildHarnessPromptLayers,
  buildHarnessSystemPrompt,
  materializeHarnessStartTranscript,
} from "./harness/adapter/prompt-builder";
import { app } from "electron";
import { getRunReviewTracker } from "./review/run-review-tracker";
import type { ReviewRunStatus } from "../../shared/review-types";
import { sendHarnessEventAsAgui } from "./harness/adapter/event-mapper";
export { sendHarnessEventAsAgui, sendTaskLifecycleAsAgui } from "./harness/adapter/event-mapper";
import { completePlanRun } from "./harness/adapter/plan-lifecycle";
import { prepareHarnessRun } from "./harness/adapter/run-preparation";
import { prepareToolRuntime } from "./harness/adapter/tool-runtime";

const LOG_PREFIX = "[HarnessAdapter]";
export { filterToolsForConversationMode } from "./harness/adapter/run-preparation";

/**
 * 运行 CyreneHarness 并返回统一的 AgentLoopResult。
 *
 * @param options CyreneRunOptions（与旧循环相同的输入）
 * @param signal 取消信号
 * @param sendBaseEvent 直接发送 AG-UI BaseEvent 的回调
 */
export async function runHarnessWithAdapter(
  options: CyreneRunOptions,
  signal: AbortSignal,
  sendBaseEvent: (event: BaseEvent) => void,
): Promise<AgentLoopResult> {
  const prepared = await prepareHarnessRun(options, signal);
  const {
    messageId,
    runId,
    threadId,
    planState,
    vendorConfig,
    tools,
    runStore,
    recovered,
    promptLayers,
    harnessPromptLayers,
    systemPrompt,
    runMessages,
  } = prepared;

  const toolRuntime = prepareToolRuntime({ options, signal, prepared, sendBaseEvent });
  const { toolContext, checkPermission, toolOutputStore, taskExecutor } = toolRuntime;

  // ── 构建 HarnessInput ──
  const harnessInput: HarnessInput = {
    systemPrompt,
    promptLayers: harnessPromptLayers,
    usageParts: promptLayers.usageParts,
    messages: runMessages,
    runId,
    ...(recovered ? { initialState: recovered.state } : {}),
    ...(recovered ? { initialCache: recovered.cache } : {}),
    tools,
    vendorConfig,
    config: {
      maxParallelToolCalls: options.maxParallelToolCalls,
      // 0 表示禁用整轮执行时钟；单次模型/工具超时仍由各自策略处理。
      totalTimeoutMs: 0,
      contextWindowTokens: options.settings.contextWindowTokens,
    },
    signal,
    onEvent: (event: HarnessEvent) => {
      if (!signal.aborted) {
        sendHarnessEventAsAgui(event, messageId, threadId, runId, sendBaseEvent);
      }
    },
    onCheckpoint: (checkpoint) => {
      runStore.checkpoint(runId, {
        messages: checkpoint.messages,
        state: checkpoint.state,
        toolOutputs: checkpoint.toolOutputs,
        rounds: checkpoint.rounds,
      });
    },
    onToolLifecycle: (event) => {
      runStore.recordTool(runId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        sideEffect: event.toolSideEffect,
        status: event.status,
      });
    },
    onCompactionLifecycle: (event) => runStore.recordCompaction(runId, event),
    requestUserClarification: options.requestUserClarification
      ? (card) => options.requestUserClarification!(card as never, signal)
      : undefined,
    includeInteractiveTools: options.harnessInteractiveTools,
    planState,
    toolContext,
    toolOutputStore,
    executionLedger: options.executionLedger,
    checkPermission,
    taskExecutor,
  };

  // ── 运行 Harness ──
  const result = await runCyreneHarness(harnessInput);

  // ── 转换结果 ──
  const completionReason = mapTerminateReason(result.terminateReason);
  // 把 HarnessResult.terminateReason 映射为 canonical terminal，
  // 供 CyreneAgent.runWithEvents 写入 RUN_FINISHED.result。
  // 优先使用 harness 自身填的 result.terminal（如果未来 harness 内部直接写）。
  // P1 修订：success 路径必须消费 Harness 的确定性状态——
  // 若 finalState.uncertainEffects 非空，externalEffectsMayContinue 必须为 true，
  // 即使 status=success 也不能谎报 false（unknown-side-effect 的诚实 final 是允许的）。
  const hasUncertainEffects = result.finalState.uncertainEffects.length > 0;
  const terminal = result.terminal ?? mapTerminateReasonToTerminal(
    result.terminateReason,
    hasUncertainEffects,
  );
  const terminalRunStatus = terminal.status === "success"
    ? "completed"
    : terminal.status === "cancelled" ? "cancelled" : "failed";
  const finalSession = runStore.markTerminal(runId, terminalRunStatus);

  // ── Review 快照：Run 终止时生成不可变 ReviewSnapshot ──
  // 正常终止时主动 finalize；崩溃恢复（interrupted）的 Run 由前端打开 Review 时
  // 通过 finalizeIfPending 按需补生成。
  try {
    const tracker = getRunReviewTracker(app.getPath("userData"));
    const reviewStatus: ReviewRunStatus = terminalRunStatus;
    tracker.finalizeReview(runId, finalSession.createdAt, reviewStatus);
  } catch (err) {
    // Review 生成失败不应阻塞 Run 结果返回
    console.error(`${LOG_PREFIX} finalizeReview failed:`, err);
  }

  // ── 计划模式 run 尾钩（设计稿 §3）──
  // 执行 run 结束（无论成败/取消）自动摘牌回 NORMAL；planPath 供前端"施工已完成"标注。
  // PLAN_DISCUSSING → PLAN_REVIEW 的转换不在 adapter 做：审批流由 agui-bridge 在
  // RUN_FINISHED 之后触发（需要 buildOptions 重开执行 run 的能力）。
  completePlanRun({
    mode: options.conversationMode,
    threadId,
    runId,
    runStatus: terminalRunStatus,
    signal,
    send: sendBaseEvent,
  });

  const toolResults: ToolCallResult[] = [];

  console.log(
    `${LOG_PREFIX} harness run complete, rounds=${result.rounds} terminated=${result.terminated} terminal=${terminal.status}`,
  );

  return {
    reply: result.finalAnswer,
    toolResults,
    completionReason,
    terminal,
    totalUsage: undefined,
  };
}
