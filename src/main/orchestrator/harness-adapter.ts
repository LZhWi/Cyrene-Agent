/**
 * CyreneHarness ↔ CyreneAgent 适配层
 *
 * 把 CyreneRunOptions 转换为 HarnessInput，运行 Harness，
 * 再把 HarnessEvent 转为 AG-UI BaseEvent，HarnessResult 转为 AgentLoopResult。
 *
 * 设计依据：docs/design/2026-08-08-cyreneHarnessloopdesign.md (v3 §11)
 */

import { EventType, type BaseEvent } from "@ag-ui/core";
import type { ChatMessage, VendorConfig } from "./vendors/types";
import type { ToolDefinition } from "./tool-registry";
import { toolRegistry } from "./tool-registry";
import { checkPermission, type ToolRiskLevel } from "../permission";
import { contextRefRegistry, extractLastUserQuery, type ToolContext } from "./tool-context";
import { runCyreneHarness } from "./harness";
import type { HarnessEvent, HarnessInput } from "./harness";
import { TODO_WORKING_NOTEBOOK_POLICY } from "./harness/todo-working-notebook";
import type { AgentLoopResult } from "./cyrene-agent";
import type { CyreneRunOptions, AgentLoopSettings } from "./cyrene-agent";
import type { ToolCallResult } from "./types";
import type { CyreneRunTerminalResult } from "../../shared/run-terminal";
import { loadPromptFile } from "../prompts/prompt-loader";

const LOG_PREFIX = "[HarnessAdapter]";

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
  const messageId = `msg-${Date.now()}`;
  // Task 2 / C1：使用 canonical runId（由 CyreneAgent.runWithEvents 写回 options.runId）。
  // 不再生成 harness-${Date.now()}，避免 ack.runId 与 RUN_STARTED.runId 不一致。
  // CyreneAgent 保证此字段已被填充（fallback 由 createRunId() 在 runWithEvents 入口补齐）。
  const runId = options.runId;
  if (!runId) {
    throw new Error(
      "[HarnessAdapter] options.runId is required. CyreneAgent.runWithEvents must populate it before invoking the adapter.",
    );
  }
  const threadId = options.conversationId ?? "default";

  console.log(`${LOG_PREFIX} starting harness run, mode=${options.conversationMode ?? "work"}`);

  // ── 构建 VendorConfig ──
  const vendorConfig: VendorConfig = {
    provider: options.settings.provider,
    baseUrl: options.settings.baseUrl,
    model: options.settings.model,
    apiKey: options.settings.apiKey,
    explicitTransport: options.settings.explicitTransport,
    reasoning: options.settings.reasoning,
  };

  // ── 构建 system prompt ──
  // Harness 使用单一 system prompt（人设 + 工具规则 + Runtime Policy）
  const systemPrompt = buildHarnessSystemPrompt(options);

  // ── 构建工具列表 ──
  const tools = [...(options.tools ?? toolRegistry.getEnabledTools())];

  // ── 构建工具上下文 ──
  const toolContext: ToolContext = {
    userQuery: extractLastUserQuery(options.messages),
    conversationId: options.conversationId ?? "default",
    runId,
    contextRefs: contextRefRegistry,
    signal,
    resolvedWorkspaceRoot: options.resolvedWorkspaceRoot,
    mode: options.conversationMode,
  };

  // ── 构建 HarnessInput ──
  const harnessInput: HarnessInput = {
    systemPrompt,
    messages: options.messages,
    tools,
    vendorConfig,
    config: {
      totalTimeoutMs: options.timeoutMs,
      contextWindowTokens: options.settings.contextWindowTokens,
    },
    signal,
    onEvent: (event: HarnessEvent) => {
      if (!signal.aborted) {
        sendHarnessEventAsAgui(event, messageId, threadId, runId, sendBaseEvent);
      }
    },
    requestUserClarification: options.requestUserClarification
      ? (card) => options.requestUserClarification!(card as never, signal)
      : undefined,
    toolContext,
    executionLedger: options.executionLedger,
    checkPermission: async (toolId: string, args: Record<string, unknown>): Promise<boolean> => {
      const tool = toolRegistry.getById(toolId);
      if (!tool) return false;
      const risk: ToolRiskLevel = (tool as ToolDefinition & { risk?: ToolRiskLevel }).risk ?? "safe";
      const perm = await checkPermission({
        toolId,
        toolName: tool.name,
        toolDescription: tool.description,
        args,
        risk,
        runId,
        signal,
      });
      return perm.allowed;
    },
  };

  // ── 运行 Harness ──
  const result = await runCyreneHarness(harnessInput);

  // ── 转换结果 ──
  const completionReason = mapTerminateReason(result.terminateReason);
  // Task 2 / C1：把 HarnessResult.terminateReason 映射为 canonical terminal，
  // 供 CyreneAgent.runWithEvents 写入 RUN_FINISHED.result。
  // 优先使用 harness 自身填的 result.terminal（如果未来 harness 内部直接写）。
  // P1 修订：success 路径必须消费 Harness 的确定性状态——
  // 若 finalState.uncertainEffects 非空，externalEffectsMayContinue 必须为 true，
  // 即使 status=success 也不能谎报 false（Task 1 已允许 unknown-side-effect 诚实 final）。
  const hasUncertainEffects = result.finalState.uncertainEffects.length > 0;
  const terminal = result.terminal ?? mapTerminateReasonToTerminal(
    result.terminateReason,
    hasUncertainEffects,
  );
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

// ── System Prompt 构建 ─────────────────────────────────────

export function buildHarnessSystemPrompt(options: CyreneRunOptions): string {
  const parts: string[] = [];

  // 人设层（Soul）
  if (options.soulSystemBaseContent) {
    parts.push(options.soulSystemBaseContent);
  }

  // Harness 专属人设（cyrene_harness.md）
  // 设计稿 §4.3: 整个 Loop 用同一份,不做动态切换
  // 设计稿 §4.5: 这是 Persona 层,不承担 Runtime Policy
  const harnessPersona = loadPromptFile("cyrene_harness.md");
  if (harnessPersona) {
    parts.push(harnessPersona);
  }

  parts.push(TODO_WORKING_NOTEBOOK_POLICY);

  // 工具调度规则
  if (options.toolSystemContent) {
    parts.push(options.toolSystemContent);
  }

  // Runtime Environment Context
  if (options.runtimeEnvironmentContext) {
    parts.push(`[RUNTIME_ENV]\n${options.runtimeEnvironmentContext}`);
  }

  if (options.recoveryContext) {
    parts.push(`[RECOVERY_CONTEXT]\n${options.recoveryContext}`);
  }

  // Response Context (CITA)
  if (options.responseContext) {
    parts.push(`[RESPONSE_CONTEXT]\n${options.responseContext}`);
  }

  // CITA 证据块
  if (options.citaContextBlock) {
    parts.push(`[CITA_CONTEXT]\n${options.citaContextBlock}`);
  }

  return parts.join("\n\n---\n\n");
}

// ── HarnessEvent → AG-UI BaseEvent ────────────────────────

/** 导出供 harness-adapter.test.ts 验证 runId stamp 不变量（Issue 6）。 */
export function sendHarnessEventAsAgui(
  event: HarnessEvent,
  messageId: string,
  threadId: string,
  runId: string,
  send: (event: BaseEvent) => void,
): void {
  switch (event.type) {
    case "round_start":
    case "round_end": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.round",
        value: {
          action: event.type === "round_start" ? "start" : "end",
          roundId: event.roundId,
        },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "progress_text": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.process_text",
        value: { content: event.content },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "final_answer": {
      // 最终回复：发为 TEXT_MESSAGE
      send({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", threadId, runId } as BaseEvent);
      send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.content, threadId, runId } as BaseEvent);
      send({ type: EventType.TEXT_MESSAGE_END, messageId, threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_start": {
      send({ type: EventType.REASONING_MESSAGE_START, messageId: event.messageId, role: "assistant", threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_delta": {
      send({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: event.messageId, delta: event.delta, threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_end": {
      send({ type: EventType.REASONING_MESSAGE_END, messageId: event.messageId, threadId, runId } as BaseEvent);
      break;
    }
    case "tool_start": {
      send({
        type: EventType.TOOL_CALL_START,
        toolCallId: event.toolCallId,
        toolCallName: event.toolName,
        threadId,
        runId,
      } as BaseEvent);
      send({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: event.toolCallId,
        delta: JSON.stringify(event.args),
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "tool_end": {
      send({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${messageId}-tool-${event.toolCallId}`,
        toolCallId: event.toolCallId,
        content: event.preview,
        role: "tool",
        status: event.outcome === "success" ? "success" : "failed",
        threadId,
        runId,
      } as BaseEvent);
      send({
        type: EventType.TOOL_CALL_END,
        toolCallId: event.toolCallId,
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "todo_update": {
      // v3: 发 cyrene.todo 事件（单数），前端订阅此事件更新 todo 卡片
      send({
        type: EventType.CUSTOM,
        name: "cyrene.todo",
        value: { items: event.items },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "runtime_feedback": {
      // Runtime Feedback 不发给 UI（内部反馈）
      break;
    }
    case "ask_user": {
      // ask_user 通过 requestUserClarification 处理，不需要额外事件
      break;
    }
    case "error": {
      console.error(`${LOG_PREFIX} harness error: ${event.message}`);
      break;
    }
  }
}

// ── 结果转换 ───────────────────────────────────────────────

function mapTerminateReason(
  reason: "max_rounds" | "timeout" | "cancelled" | "error" | undefined,
): "no_tool" | "timeout" | "max_rounds" | "tool_error" {
  switch (reason) {
    case "max_rounds":
      return "max_rounds";
    case "timeout":
      return "timeout";
    case "error":
      return "tool_error";
    default:
      return "no_tool";
  }
}

/**
 * 把 HarnessResult.terminateReason 映射为 canonical CyreneRunTerminalResult（Task 2 / C1）。
 *
 * 映射策略（与 plan §Task 2 冻结边界一致）：
 * - undefined + hasUncertainEffects=false → success / false（模型自然收尾，无 unresolved uncertainty）
 * - undefined + hasUncertainEffects=true  → success / true（Task 1 允许的 unknown-side-effect 诚实 final）
 * - "max_rounds" → timeout, reason="max_rounds"
 * - "timeout" → timeout, reason="timeout"
 * - "cancelled" → cancelled, reason="user_cancelled"
 * - "error" → runtime_error, reason="E_HARNESS_FAILURE"
 *
 * P1 修订：success 路径的 externalEffectsMayContinue 由 hasUncertainEffects 决定，
 * 不再固定 false。cancelled / timeout / runtime_error 恒为 true，不受第二参数影响。
 *
 * Issue 2：cancelled / error 不再被 default 吞成 success。
 * runtime_error 必须最终走 RUN_ERROR（由 agui-bridge 在 next 回调里转换），
 * 不能触发成功收尾副作用（bridge complete 回调据 status 判定）。
 *
 * Issue 3：externalEffectsMayContinue 为必填 invariant。
 *
 * 导出供 harness-adapter.test.ts 直接单测映射不变量。
 *
 * @param reason HarnessResult.terminateReason
 * @param hasUncertainEffects result.finalState.uncertainEffects.length > 0；
 *   仅影响 undefined（success）路径，其他终态恒为 true。默认 false 保持向后兼容。
 */
export function mapTerminateReasonToTerminal(
  reason: "max_rounds" | "timeout" | "cancelled" | "error" | undefined,
  hasUncertainEffects: boolean = false,
): CyreneRunTerminalResult {
  switch (reason) {
    case "max_rounds":
      return { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true };
    case "timeout":
      return { status: "timeout", reason: "timeout", externalEffectsMayContinue: true };
    case "cancelled":
      return { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true };
    case "error":
      return { status: "runtime_error", reason: "E_HARNESS_FAILURE", externalEffectsMayContinue: true };
    default:
      // P1 修订：success 路径必须尊重 uncertainEffects，不能谎报 false。
      return { status: "success", externalEffectsMayContinue: hasUncertainEffects };
  }
}
