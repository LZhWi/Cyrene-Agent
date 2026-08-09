/**
 * CyreneHarness 核心循环（v3 §3.1）
 *
 * 连续 Agent Loop：while 循环 + function calling + content 流式。
 *
 * v3 关键修正：
 * - 每轮 assistant response 必须写回 messages（P0 blocker）
 * - uncertainEffects 拦截重复副作用
 * - Harness 内置工具统一 dispatch
 * - 同轮多 tool call 遇 fatal/unknown 中断
 * - mid-loop compaction 每轮检查
 * - 工具输出双级截断
 */

import { getAdapterForConfig, streamChatWithSdk } from "../vendors";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ToolCall,
  ToolSpec,
  VendorConfig,
} from "../vendors/types";
import type { ToolDefinition } from "../tool-registry";
import type { ToolCallResult } from "../types";
import type {
  AgentState,
  HarnessConfig,
  HarnessEvent,
  HarnessInput,
  HarnessResult,
  ToolObservation,
} from "./types";
import { parseToolCallArgs, toolCallFingerprint, DEFAULT_HARNESS_CONFIG } from "./types";
import { getHarnessBuiltinToolSpecs, isHarnessBuiltin } from "./builtin-tools";
import { dispatchToolCall, type ToolDispatchResult } from "./tool-dispatcher";
import { resolveSideEffect } from "./side-effect-resolver";
import { classifyToolError, classifyToolResultError } from "./error-classifier";
import { decideRetry, getRetryParams, sleepWithJitter } from "./retry-policy";
import { computeTokenBudget, compressForAgentLoop } from "./compaction";
import { StreamController } from "./stream-controller";
import { TimeoutClock } from "./timeout-clock";
import { isCancellationError, raceWithSignal } from "../../abort-utils";
import { isExplicitStreamUnsupported } from "../vendors/stream-support";

const LOG_PREFIX = "[CyreneHarness]";

// ── Task 3 / C2：signal-aware 工具函数 ────────────────────

/**
 * 构造 cancelled 结果（空 finalAnswer，不发 final_answer 事件）。
 * cancelled 不得生成 "最终回复被取消。" 或任何 final_answer 事件。
 */
function buildCancelledResult(state: AgentState, rounds: number): HarnessResult {
  return {
    finalAnswer: "",
    finalState: state,
    terminated: true,
    terminateReason: "cancelled",
    terminal: { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true },
    rounds,
  };
}

/**
 * 运行 CyreneHarness（v3 §3.1）。
 */
export async function runCyreneHarness(input: HarnessInput): Promise<HarnessResult> {
  const config: HarnessConfig = { ...DEFAULT_HARNESS_CONFIG, ...input.config };
  const state: AgentState = {
    todoItems: [],
    uncertainEffects: [],
  };

  const streamController = new StreamController();
  const clock = new TimeoutClock(config.totalTimeoutMs, config.userWaitTimeoutMs);
  clock.startActive();

  // 构建 tools 清单（v3 §3.1：registry + harness built-in）
  const registryToolSpecs: ToolSpec[] = input.tools.map((t) => ({
    name: t.id,
    description: t.description,
    parameters: {
      type: "object" as const,
      properties: t.inputSchema.properties,
      required: t.inputSchema.required,
    },
  }));
  const allToolSpecs: ToolSpec[] = [...registryToolSpecs, ...getHarnessBuiltinToolSpecs()];

  let messages: ChatMessage[] = [...input.messages];
  let rounds = 0;

  // ── 主循环 ──
  while (rounds < config.maxRounds && !clock.isExecutionTimeout()) {
    if (input.signal?.aborted) {
      // Task 3 / C2：cancelled 不生成 "最终回复被取消。"，finalAnswer 为空。
      return buildCancelledResult(state, rounds);
    }

    // ═══ Mid-loop compaction（v3 §10.6）═══
    const budget = computeTokenBudget(
      input.systemPrompt,
      allToolSpecs,
      messages,
      config.contextWindowTokens,
      config.reservedOutputTokens,
      config.safetyMarginTokens,
      config.compactionThreshold,
    );

    if (budget.needsCompaction) {
      console.log(`${LOG_PREFIX} mid-loop compaction triggered (estimated=${budget.estimatedInput} budget=${budget.usableInputBudget})`);
      messages = await compressForAgentLoop({
        systemPrompt: input.systemPrompt,
        toolSchemas: allToolSpecs,
        messages,
        contextWindow: config.contextWindowTokens,
        reservedOutput: config.reservedOutputTokens,
        safetyMargin: config.safetyMarginTokens,
        threshold: config.compactionThreshold,
        keepRecentCount: 20,
        summarize: async (history) => {
          // 复用现有 LLM 做摘要
          return summarizeHistory(input.vendorConfig, input.systemPrompt, history, config, input.signal);
        },
      });
    }

    // ═══ callLLM ═══
    let response: ChatResponse;
    const reasoningMessageId = `reasoning-${rounds}`;
    let reasoningStarted = false;
    try {
      response = await callLLM(
        input.vendorConfig,
        input.systemPrompt,
        messages,
        allToolSpecs,
        config,
        input.signal,
        (delta) => {
          if (!reasoningStarted) {
            reasoningStarted = true;
            input.onEvent?.({ type: "reasoning_start", messageId: reasoningMessageId });
          }
          input.onEvent?.({ type: "reasoning_delta", messageId: reasoningMessageId, delta });
        },
      );
    } catch (err) {
      // Task 3 / C2：signal abort → cancelled，不分类为 error。
      if (input.signal?.aborted) {
        return buildCancelledResult(state, rounds);
      }
      console.error(`${LOG_PREFIX} LLM call failed:`, err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      return buildResult(`抱歉，模型调用失败：${errorMsg}`, state, true, "error", rounds);
    } finally {
      if (reasoningStarted) {
        input.onEvent?.({ type: "reasoning_end", messageId: reasoningMessageId });
      }
    }

    // ═══ Assistant response 必须写回 transcript（v3 P0 blocker）═══
    const assistantMessage: ChatMessage = response.assistantMessage ?? {
      role: "assistant",
      content: response.text,
      ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}),
    };
    messages.push(assistantMessage);

    // ═══ Progress Stream vs Final Commit（v3 §7）═══
    if (response.text) {
      streamController.bufferProgressContent(response.text);
    }

    // ═══ Tool Call Processing ═══
    const toolCalls = response.toolCalls ?? [];

    if (toolCalls.length > 0) {
      // ── 用户等待类内置工具排他检查（v3 §9.2）──
      const exclusiveToolNames = new Set(["ask_user", "confirm_uncertain_effect"]);
      const askCalls = toolCalls.filter((c) => exclusiveToolNames.has(c.name));
      const otherCalls = toolCalls.filter((c) => !exclusiveToolNames.has(c.name));

      if (askCalls.length > 0) {
        const primaryAsk = askCalls[0];

        // 其余 ask_user 返回 not_executed
        for (const call of askCalls.slice(1)) {
          messages.push(toolResultMessage(call, {
            outcome: "not_executed",
            reason: "not_executed_due_to_another_ask",
          }));
        }

        // 同轮普通工具调用返回 not_executed
        for (const call of otherCalls) {
          messages.push(toolResultMessage(call, {
            outcome: "not_executed",
            reason: "not_executed_due_to_clarification",
          }));
        }

        // 执行 ask_user
        clock.startUserWait();
        let askResult: ToolDispatchResult;
        try {
          askResult = await raceWithSignal(
            dispatchToolCall(primaryAsk, {
              state,
              tools: input.tools,
              onEvent: input.onEvent,
              requestUserClarification: input.requestUserClarification,
            }),
            input.signal,
          );
        } catch (error) {
          // Task 3 / C2：ask_user 等待期间 abort → cancelled
          clock.stopUserWait();
          if (isCancellationError(error, input.signal)) {
            return buildCancelledResult(state, rounds);
          }
          throw error;
        }
        clock.stopUserWait();

        messages.push(toolResultMessage(primaryAsk, askResult));

        // ask_user 后丢弃 progress buffer，等待模型重新决策
        streamController.discardProgressBuffer();
        rounds++;
        continue;
      }

      // ── 普通工具循环（无 ask_user）──
      // flush buffered content 为 progress message
      const progressContent = streamController.flushProgressBufferAsProgress();
      if (progressContent) {
        input.onEvent?.({ type: "progress_text", content: progressContent });
      }

      let halted = false;
      for (const call of otherCalls) {
        // ── halt 后续调用返回 not_executed ──
        if (halted) {
          messages.push(toolResultMessage(call, {
            outcome: "not_executed",
            reason: "runtime_halted_after_prior_uncertain_side_effect_or_fatal",
          }));
          continue;
        }

        // Task 3 / C2：工具执行前检查 signal
        if (input.signal?.aborted) {
          return buildCancelledResult(state, rounds);
        }

        // ── 统一 dispatch（v3 §3.1）──
        // Task 3 / C2：用 raceWithSignal 包裹，abort 时立即返回 cancelled。
        let dispatchResult: ToolDispatchResult;
        try {
          dispatchResult = await raceWithSignal(
            dispatchToolCall(call, {
              state,
              tools: input.tools,
              onEvent: input.onEvent,
              requestUserClarification: input.requestUserClarification,
              checkPermission: input.checkPermission,
              toolContext: input.toolContext,
              executionLedger: input.executionLedger,
            }),
            input.signal,
          );
        } catch (error) {
          // 工具执行/权限检查期间 abort → cancelled
          if (isCancellationError(error, input.signal)) {
            return buildCancelledResult(state, rounds);
          }
          throw error;
        }

        let result = dispatchResult;

        // ── 失败重试（v3 §5.3）──
        if (result.outcome === "failure") {
          const category = result.category ?? classifyToolResultError(result.rawResult ?? { toolId: call.name, args: {}, output: "", status: "failed" } as ToolCallResult);
          const sideEffect = resolveSideEffect(
            input.tools.find((t) => t.id === call.name),
            parseToolCallArgs(call),
          );
          const retryDecision = decideRetry(category, sideEffect);

          if (retryDecision === "retry") {
            const retryParams = getRetryParams(category);
            let retryResult = result;
            for (let attempt = 0; attempt < retryParams.maxRetries; attempt++) {
              // Task 3 / C2：retry backoff 用可中断 sleep
              try {
                await sleepWithJitter(retryParams.backoffMs[attempt] ?? 1000, input.signal);
              } catch (error) {
                // backoff 期间 abort → cancelled
                if (isCancellationError(error, input.signal)) {
                  return buildCancelledResult(state, rounds);
                }
                throw error;
              }
              if (input.signal?.aborted) {
                return buildCancelledResult(state, rounds);
              }
              let retryDispatch: ToolDispatchResult;
              try {
                retryDispatch = await raceWithSignal(
                  dispatchToolCall(call, {
                    state,
                    tools: input.tools,
                    onEvent: input.onEvent,
                    requestUserClarification: input.requestUserClarification,
                    checkPermission: input.checkPermission,
                    toolContext: input.toolContext,
                    executionLedger: input.executionLedger,
                  }),
                  input.signal,
                );
              } catch (error) {
                // retry 工具执行期间 abort → cancelled
                if (isCancellationError(error, input.signal)) {
                  return buildCancelledResult(state, rounds);
                }
                throw error;
              }
              retryResult = retryDispatch;
              if (retryResult.outcome !== "failure") break;
            }
            result = retryResult;
          }
        }

        // ── 写回 tool result ──
        messages.push(toolResultMessage(call, result));

        // ── uncertainEffects 拦截（v3 §5.5.1.1）──
        if (result.outcome === "unknown") {
          const tool = input.tools.find((t) => t.id === call.name);
          const sideEffect = resolveSideEffect(tool, parseToolCallArgs(call));
          if (sideEffect === "non_idempotent_side_effect") {
            const fingerprint = toolCallFingerprint(call.name, parseToolCallArgs(call));
            const effectId = `${input.toolContext?.runId ?? "unknown-run"}:${call.id}`;
            if (!state.uncertainEffects.some((effect) => effect.id === effectId)) {
              state.uncertainEffects.push({
                id: effectId,
                toolCallId: call.id,
                fingerprint,
                toolName: call.name,
                message: "副作用已发起，但 Runtime 无法确认是否生效",
              });
            }
            halted = true; // 本轮后续 side-effect 调用暂停
          }
        }

        // ── fatal 也 halt ──
        if (result.category === "fatal") {
          halted = true;
        }
      }

      rounds++;
      continue;
    }

    // ═══ Model Wants to End（P0-A：模型不再调用工具即结束）═══
    // 不再检查 completionObligations 或 uncertainEffects：模型已选择结束当前 turn。
    // uncertainEffects 仍作为执行期安全状态保留（阻止相同危险副作用自动重放），
    // 但不参与 final settlement。
    const finalAnswer = streamController.commitProgressBuffer();
    input.onEvent?.({ type: "final_answer", content: finalAnswer });
    clock.stopActive();
    return buildResult(finalAnswer, state, false, undefined, rounds);
  }

  // ── 兜底：超 maxRounds 或超时 ──
  clock.stopActive();
  const reason = clock.isExecutionTimeout() ? "timeout" : "max_rounds";
  const finalAnswer = streamController.getBuffered() || buildTimeoutReply(state, reason);
  input.onEvent?.({ type: "final_answer", content: finalAnswer });
  return buildResult(finalAnswer, state, true, reason, rounds);
}

// ── LLM 调用 ─────────────────────────────────────────────

async function callLLM(
  vendorConfig: VendorConfig,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
  config: HarnessConfig,
  signal?: AbortSignal,
  onReasoningDelta?: (delta: string) => void,
): Promise<ChatResponse> {
  const adapter = getAdapterForConfig(vendorConfig);
  const chatRequest: ChatRequest = {
    model: vendorConfig.model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    tools,
    stream: true,
    maxTokens: config.reservedOutputTokens,
  };

  let receivedStreamDelta = false;
  try {
    return await streamChatWithSdk({
      adapter,
      request: chatRequest,
      config: vendorConfig,
      timeoutMs: config.totalTimeoutMs,
      signal,
      onDelta: (delta) => {
        receivedStreamDelta = true;
        if (delta.type === "reasoning_delta" && delta.delta) onReasoningDelta?.(delta.delta);
      },
    });
  } catch (error) {
    if (receivedStreamDelta || !isExplicitStreamUnsupported(error)) throw error;
  }

  // 部分兼容模型明确拒绝 stream + tools；只在零增量、明确不支持时降级，绝不重放半截流。
  const fallbackRequest: ChatRequest = { ...chatRequest, stream: false };
  const http = adapter.buildRequest(fallbackRequest, vendorConfig);
  const response = await fetch(http.url, {
    method: "POST",
    headers: http.headers,
    body: http.body,
    signal,
  });
  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(errorData.error?.message || `模型请求失败：HTTP ${response.status}`);
  }
  return adapter.parseResponse(await response.json());
}

// ── 历史摘要（用于 mid-loop compaction）──────────────────

async function summarizeHistory(
  vendorConfig: VendorConfig,
  systemPrompt: string,
  history: string,
  config: HarnessConfig,
  signal?: AbortSignal,
): Promise<string> {
  const adapter = getAdapterForConfig(vendorConfig);
  const compactionPrompt = `你正在帮 Agent 整理执行历史的摘要。请把下面这段较早的执行历史总结成一段简洁的摘要，供后续继续执行参考。

要求：
1. 保留用户的核心目标、当前任务、未完成的待办事项。
2. **保留已执行的工具操作序列及其确定性结果**（文件路径、命令、退出码、错误信息）。
3. 保留已确认的事实和数据（如路径、文件名、参数值）。
4. 保留 todo 状态和未确认的 uncertain effects（已发起但结果未知的副作用）。
5. 删除模型自言自语、重复确认、过渡性语句。
6. 摘要控制在 400~600 字以内，用中文输出。

执行历史：
${history}

请直接输出摘要内容，不要加任何前缀说明。`;

  const chatRequest: ChatRequest = {
    model: vendorConfig.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: compactionPrompt },
    ],
    stream: false,
    maxTokens: config.reservedOutputTokens,
  };

  const http = adapter.buildRequest(chatRequest, vendorConfig);
  const response = await fetch(http.url, {
    method: "POST",
    headers: http.headers,
    body: http.body,
    signal,
  });

  if (!response.ok) {
    throw new Error(`摘要请求失败：HTTP ${response.status}`);
  }

  const result = adapter.parseResponse(await response.json());
  return result.text;
}

// ── 辅助函数 ─────────────────────────────────────────────

function toolResultMessage(
  call: ToolCall,
  observation: ToolObservation | { outcome: string; reason: string },
): ChatMessage {
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify(observation),
  };
}

function buildTimeoutReply(state: AgentState, reason: string): string {
  const parts: string[] = [
    "抱歉，任务执行时间较长，已达到时间上限。",
    "",
    `中断原因：${reason === "timeout" ? "执行超时" : "达到最大轮数"}`,
  ];

  if (state.todoItems.length > 0) {
    parts.push("", "当前待办状态：");
    for (const t of state.todoItems) {
      parts.push(`  [${t.status}] ${t.content}`);
    }
  }

  if (state.uncertainEffects.length > 0) {
    parts.push("", "⚠️ 以下副作用结果未知：");
    for (const e of state.uncertainEffects) {
      parts.push(`  - ${e.toolName}: ${e.message}`);
    }
  }

  return parts.join("\n");
}

function buildResult(
  finalAnswer: string,
  state: AgentState,
  terminated: boolean,
  terminateReason: HarnessResult["terminateReason"],
  rounds: number,
): HarnessResult {
  return {
    finalAnswer,
    finalState: state,
    terminated,
    terminateReason,
    rounds,
  };
}
