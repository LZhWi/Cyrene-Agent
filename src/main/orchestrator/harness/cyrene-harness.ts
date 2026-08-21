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

import { createHash } from "node:crypto";
import { getAdapterForConfig, streamChatWithSdk } from "../vendors";
import { recordUsage, recordRequest } from "../../token-usage-store";
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
  HarnessCacheState,
  HarnessConfig,
  HarnessEvent,
  HarnessInput,
  HarnessResult,
  ToolObservation,
} from "./types";
import type { ToolOutputRef } from "./tool-output/tool-output-store";
import { INITIAL_HARNESS_CACHE_STATE, parseToolCallArgs, toolCallFingerprint, DEFAULT_HARNESS_CONFIG } from "./types";
import { getHarnessBuiltinToolSpecs, isHarnessBuiltin } from "./builtin-tools";
import { dispatchToolCall, persistToolDispatchResult, type ToolDispatchResult } from "./tool-dispatcher";
import { classifyToolExecutionMode, scheduleToolCalls } from "./tool-call-scheduler";
import { resolveSideEffect } from "./side-effect-resolver";
import { extractFileChangesFromOutput } from "../tool-evidence";
import { classifyToolError, classifyToolResultError } from "./error-classifier";
import { decideRetry, getRetryParams, sleepWithJitter } from "./retry-policy";
import { AGENT_COMPACTION_PROMPT, computeTokenBudget, compressForAgentLoop } from "./compaction";
import { buildContextUsageSnapshot } from "../context-usage";
import { StreamController } from "./stream-controller";
import { TimeoutClock } from "./timeout-clock";
import { buildCurrentTodoNotebookContext } from "./todo-working-notebook";
import { appendInternalTranscriptMessage, createInternalTranscriptMessage } from "./internal-transcript";
import { isCancellationError, raceWithSignal } from "../../abort-utils";
import { isExplicitStreamUnsupported } from "../vendors/stream-support";
import {
  buildStableSystemPrefix,
  composePromptLayers,
  normalizeToolSpecsForCache,
  projectCacheRelevantRequest,
  type PromptLayers,
} from "../prompt-layers";

const LOG_PREFIX = "[CyreneHarness]";

function fingerprintCacheDiagnostic(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

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
  const state: AgentState = input.initialState
    ? JSON.parse(JSON.stringify(input.initialState)) as AgentState
    : { todoItems: [], uncertainEffects: [] };

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
  const allToolSpecs: ToolSpec[] = [
    ...registryToolSpecs,
    ...getHarnessBuiltinToolSpecs({
      includeInteractive: input.includeInteractiveTools,
      includeTask: Boolean(input.taskExecutor),
      planState: input.planState,
    }),
  ];

  let messages: ChatMessage[] = [...input.messages];
  let rounds = 0;
  let cache: HarnessCacheState = input.initialCache
    ? { ...input.initialCache }
    : { ...INITIAL_HARNESS_CACHE_STATE };
  let toolOutputs: ToolOutputRef[] = [];
  let checkpointFailure: string | undefined;

  // 每轮临时拼接 runtimeContext 会使上一请求不再是下一请求的前缀。
  // 所有启动时已知的动态事实在这里一次性物化为 transcript 尾部。
  const initialContextParts = [
    input.initialInternalContext?.content,
    input.promptLayers?.runtimeContext,
    state.todoItems.length > 0 ? buildCurrentTodoNotebookContext(state.todoItems) : undefined,
  ].filter((part): part is string => Boolean(part?.trim()));
  if (initialContextParts.length > 0) {
    const latestRevision = messages.reduce(
      (current, message) => Math.max(current, message.internal?.revision ?? 0),
      0,
    );
    messages = appendInternalTranscriptMessage(messages, createInternalTranscriptMessage({
      kind: input.initialInternalContext?.kind ?? "run_start",
      revision: latestRevision + 1,
      runId: input.runId ?? "harness-run",
      content: initialContextParts.join("\n\n---\n\n"),
    }));
  }

  const checkpoint = (): void => {
    try {
      input.onCheckpoint?.({
        messages: JSON.parse(JSON.stringify(messages)) as ChatMessage[],
        state: JSON.parse(JSON.stringify(state)) as AgentState,
        toolOutputs: JSON.parse(JSON.stringify(toolOutputs)) as ToolOutputRef[],
        rounds,
        cache: { ...cache },
        at: Date.now(),
      });
    } catch (error) {
      checkpointFailure = error instanceof Error ? error.message : String(error);
      console.error(`${LOG_PREFIX} checkpoint failed:`, error);
    }
  };
  const cancelled = (): HarnessResult => {
    checkpoint();
    if (checkpointFailure) {
      return buildResult(`执行状态保存失败：${checkpointFailure}`, state, true, "error", rounds);
    }
    return buildCancelledResult(state, rounds);
  };
  /**
   * 上下文容量快照（docs/context-usage-viewer-construction-plan.md）：
   * - preRequest：每轮 compaction 后、callLLM 前，代表本轮真正发给模型的 input；
   * - terminal：finish() 统一出口，此时 final assistant 已写回 transcript，含最终回复。
   * harness 的动态事实已物化为 internal transcript 消息，无独立 runtimeContext 计量。
   */
  const emitContextUsage = (phase: "preRequest" | "terminal"): void => {
    const stablePrefix = input.promptLayers?.stablePrefix ?? input.systemPrompt;
    const usageParts = input.usageParts
      ?? { personaContent: stablePrefix, toolLayerContent: "" };
    input.onEvent?.({
      type: "context_usage",
      snapshot: buildContextUsageSnapshot({
        phase,
        ...(input.runId ? { runId: input.runId } : {}),
        round: rounds,
        contextWindowTokens: config.contextWindowTokens,
        personaContent: usageParts.personaContent,
        toolLayerContent: usageParts.toolLayerContent,
        toolSpecs: allToolSpecs,
        messages,
      }),
    });
  };
  const finish = (
    finalAnswer: string,
    terminated: boolean,
    terminateReason: HarnessResult["terminateReason"],
  ): HarnessResult => {
    emitContextUsage("terminal");
    checkpoint();
    if (checkpointFailure) {
      return buildResult(`执行状态保存失败：${checkpointFailure}`, state, true, "error", rounds);
    }
    return buildResult(finalAnswer, state, terminated, terminateReason, rounds);
  };

  // ── 主循环 ──
  while (!clock.isExecutionTimeout()) {
    if (checkpointFailure) {
      return buildResult(`执行状态保存失败：${checkpointFailure}`, state, true, "error", rounds);
    }
    if (input.signal?.aborted) {
      // Task 3 / C2：cancelled 不生成 "最终回复被取消。"，finalAnswer 为空。
      return cancelled();
    }

    const promptLayers: PromptLayers = {
      stablePrefix: input.promptLayers?.stablePrefix ?? input.systemPrompt,
      ...(input.promptLayers?.sessionPrefix ? { sessionPrefix: input.promptLayers.sessionPrefix } : {}),
      ...(input.promptLayers?.mode ? { mode: input.promptLayers.mode } : {}),
    };
    // 仅用于本地预算与摘要准确性；不可直接作为 wire system prompt。
    const roundSystemPrompt = [
      buildStableSystemPrefix(promptLayers),
    ].filter(Boolean).join("\n\n---\n\n");

    const roundId = `round-${rounds}`;
    input.onEvent?.({ type: "round_start", roundId });

    // ═══ Mid-loop compaction（v3 §10.6）═══
    const budget = computeTokenBudget(
      roundSystemPrompt,
      allToolSpecs,
      messages,
      config.contextWindowTokens,
      config.reservedOutputTokens,
      config.safetyMarginTokens,
      config.compactionThreshold,
    );

    if (budget.needsCompaction) {
      console.log(`${LOG_PREFIX} mid-loop compaction triggered (estimated=${budget.estimatedInput} budget=${budget.usableInputBudget})`);
      const messageCountBeforeCompaction = messages.length;
      input.onCompactionLifecycle?.({ status: "started", messageCountBefore: messageCountBeforeCompaction });
      const compactedMessages = await compressForAgentLoop({
        messages,
        retainTokens: Math.floor(config.contextWindowTokens * config.compactionRetainRatio),
        summarize: async (history) => {
          return summarizeHistory(
            input.vendorConfig,
            roundSystemPrompt,
            history,
            allToolSpecs,
            config,
            input.signal,
          );
        },
      });
      if (compactedMessages !== messages) {
        cache = {
          cacheEpoch: cache.cacheEpoch + 1,
          epochReason: "compaction",
        };
        messages = compactedMessages;
        input.onCompactionLifecycle?.({
          status: "committed",
          messageCountBefore: messageCountBeforeCompaction,
          messageCountAfter: compactedMessages.length,
          cache: { ...cache },
        });
        // 压缩已替换模型历史；下一次请求前必须持久化新 epoch，避免崩溃后混淆周期。
        checkpoint();
      } else {
        messages = compactedMessages;
      }
    }

    // ═══ 上下文容量快照（preRequest）═══
    // 压缩后、请求前：快照准确代表本轮真正发给模型的 input。
    emitContextUsage("preRequest");

    // ═══ callLLM ═══
    const cacheRequest = projectCacheRelevantRequest({
      stableSystem: buildStableSystemPrefix(promptLayers),
      tools: allToolSpecs,
      messages,
    });
    input.onCacheDiagnostic?.({
      ...(input.runId ? { runId: input.runId } : {}),
      cacheEpoch: cache.cacheEpoch,
      round: rounds,
      stablePromptFingerprint: fingerprintCacheDiagnostic(cacheRequest.stableSystem),
      toolSchemaFingerprint: fingerprintCacheDiagnostic(cacheRequest.tools),
      messagePrefixFingerprint: fingerprintCacheDiagnostic(cacheRequest.messages),
      messageCount: cacheRequest.messages.length,
    });
    let response: ChatResponse;
    const reasoningMessageId = `reasoning-${rounds}`;
    let reasoningStarted = false;
    try {
      response = await callLLM(
        input.vendorConfig,
        promptLayers,
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
        return cancelled();
      }
      console.error(`${LOG_PREFIX} LLM call failed:`, err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      return finish(`抱歉，模型调用失败：${errorMsg}`, true, "error");
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
      const exclusiveToolNames = input.includeInteractiveTools === false
        ? new Set<string>()
        : new Set(["ask_user", "confirm_uncertain_effect"]);
      const askCalls = toolCalls.filter((c) => exclusiveToolNames.has(c.name));
      const otherCalls = toolCalls.filter((c) => !exclusiveToolNames.has(c.name));

      if (askCalls.length > 0) {
        const primaryAsk = askCalls[0];

        // 其余 ask_user 返回 not_executed
        for (const call of askCalls.slice(1)) {
          input.onToolLifecycle?.({ toolCallId: call.id, toolName: call.name, toolSideEffect: "read_only", status: "not_executed" });
          messages.push(toolResultMessage(call, {
            outcome: "not_executed",
            reason: "not_executed_due_to_another_ask",
          }));
        }

        // 同轮普通工具调用返回 not_executed
        for (const call of otherCalls) {
          input.onToolLifecycle?.({
            toolCallId: call.id,
            toolName: call.name,
            toolSideEffect: resolveSideEffect(input.tools.find((tool) => tool.id === call.name), parseToolCallArgs(call)),
            status: "not_executed",
          });
          messages.push(toolResultMessage(call, {
            outcome: "not_executed",
            reason: "not_executed_due_to_clarification",
          }));
        }

        // 执行 ask_user
        clock.startUserWait();
        input.onToolLifecycle?.({ toolCallId: primaryAsk.id, toolName: primaryAsk.name, toolSideEffect: "read_only", status: "started" });
        let askResult: ToolDispatchResult;
        try {
          askResult = await raceWithSignal(
            dispatchToolCall(primaryAsk, {
              state,
              tools: input.tools,
              onEvent: input.onEvent,
              requestUserClarification: input.requestUserClarification,
              includeInteractiveTools: input.includeInteractiveTools,
              toolOutputStore: input.toolOutputStore,
            }),
            input.signal,
          );
        } catch (error) {
          // Task 3 / C2：ask_user 等待期间 abort → cancelled
          clock.stopUserWait();
          if (isCancellationError(error, input.signal)) {
            return cancelled();
          }
          throw error;
        }
        clock.stopUserWait();

        messages.push(toolResultMessage(primaryAsk, askResult));
        input.onToolLifecycle?.({
          toolCallId: primaryAsk.id,
          toolName: primaryAsk.name,
          toolSideEffect: "read_only",
          status: askResult.outcome === "unknown" ? "unknown" : askResult.outcome === "not_executed" ? "not_executed" : "committed",
        });

        // ask_user 后丢弃 progress buffer，等待模型重新决策
        streamController.discardProgressBuffer();
        input.onEvent?.({ type: "round_end", roundId });
        rounds++;
        checkpoint();
        continue;
      }

      // ── 普通工具循环（无 ask_user）──
      // flush buffered content 为 progress message
      const progressContent = streamController.flushProgressBufferAsProgress();
      if (progressContent) {
        input.onEvent?.({ type: "progress_text", content: progressContent });
      }

      const dispatchContext = {
        state,
        tools: input.tools,
        onEvent: input.onEvent,
        requestUserClarification: input.requestUserClarification,
        includeInteractiveTools: input.includeInteractiveTools,
        checkPermission: input.checkPermission,
        toolContext: input.toolContext,
        executionLedger: input.executionLedger,
        taskExecutor: input.taskExecutor,
        toolOutputStore: input.toolOutputStore,
        deferOutputPersistence: true,
      };

      /** 一次 logical invocation 的执行、重试和完整输出持久化可在安全池内重叠。 */
      const executeWithRetry = async (call: ToolCall): Promise<ToolDispatchResult> => {
        const toolSideEffect = resolveSideEffect(input.tools.find((tool) => tool.id === call.name), parseToolCallArgs(call));
        input.onToolLifecycle?.({
          toolCallId: call.id,
          toolName: call.name,
          toolSideEffect,
          status: "started",
        });
        let result = await raceWithSignal(dispatchToolCall(call, dispatchContext), input.signal);
        if (result.outcome === "failure") {
          const category = result.category ?? classifyToolResultError(
            result.rawResult ?? { toolId: call.name, args: {}, output: "", status: "failed" } as ToolCallResult,
          );
          const sideEffect = resolveSideEffect(input.tools.find((tool) => tool.id === call.name), parseToolCallArgs(call));
          const retryDecision = decideRetry(category, sideEffect);
          if (retryDecision === "retry") {
            const retryParams = getRetryParams(category);
            for (let attempt = 0; attempt < retryParams.maxRetries; attempt++) {
              await sleepWithJitter(retryParams.backoffMs[attempt] ?? 1000, input.signal);
              result = await raceWithSignal(dispatchToolCall(call, dispatchContext), input.signal);
              if (result.outcome !== "failure") break;
            }
          }
        }
        return persistToolDispatchResult(call, result, dispatchContext);
      };

      /** 所有模型可见写回都经此处按原始 tool-call 顺序发生。 */
      const commitToolResult = async (
        call: ToolCall,
        result: ToolDispatchResult,
      ): Promise<"continue" | "halt"> => {
        const toolSideEffect = result.toolSideEffect
          ?? resolveSideEffect(input.tools.find((tool) => tool.id === call.name), parseToolCallArgs(call));
        if (result.toolOutputRef && !toolOutputs.some((entry) => entry.recordId === result.toolOutputRef?.recordId)) {
          toolOutputs.push(result.toolOutputRef);
        }
        input.onEvent?.({
          type: "tool_end",
          toolCallId: call.id,
          outcome: result.outcome,
          preview: (result.preview ?? result.message).slice(0, 200),
          // Diff Review 卡片证据走独立字段，不受 preview 截断影响
          changes: extractFileChangesFromOutput(result.output),
        });
        messages.push(toolResultMessage(call, result));
        input.onToolLifecycle?.({
          toolCallId: call.id,
          toolName: call.name,
          toolSideEffect,
          status: result.outcome === "unknown"
            ? "unknown"
            : result.outcome === "not_executed" ? "not_executed" : "committed",
        });

        if (result.outcome === "unknown") {
          const tool = input.tools.find((candidate) => candidate.id === call.name);
          const sideEffect = toolSideEffect;
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
            return "halt";
          }
        }
        return result.category === "fatal" ? "halt" : "continue";
      };

      let schedule;
      try {
        schedule = await scheduleToolCalls({
          calls: otherCalls,
          maxParallel: config.maxParallelToolCalls,
          signal: input.signal,
          classify: (call) => classifyToolExecutionMode(call, input.tools),
          execute: ({ call }) => executeWithRetry(call),
          commit: ({ call }, result) => commitToolResult(call, result),
          notExecuted: async ({ call }, reason): Promise<ToolDispatchResult> => ({
            outcome: "not_executed",
            category: "runtime_safety",
            tool: call.name,
            message: reason,
          }),
        });
      } catch (error) {
        if (isCancellationError(error, input.signal)) return cancelled();
        throw error;
      }
      if (schedule.cancelled || input.signal?.aborted) return cancelled();

      input.onEvent?.({ type: "round_end", roundId });
      rounds++;
      checkpoint();
      continue;
    }

    // ═══ Model Wants to End（P0-A：模型不再调用工具即结束）═══
    // 不再检查 completionObligations 或 uncertainEffects：模型已选择结束当前 turn。
    // uncertainEffects 仍作为执行期安全状态保留（阻止相同危险副作用自动重放），
    // 但不参与 final settlement。
    const finalAnswer = streamController.commitProgressBuffer();
    input.onEvent?.({ type: "round_end", roundId });
    input.onEvent?.({ type: "final_answer", content: finalAnswer });
    clock.stopActive();
    return finish(finalAnswer, false, undefined);
  }

  // ── 兜底：显式配置的总超时 ──
  clock.stopActive();
  const finalAnswer = streamController.getBuffered() || buildTimeoutReply(state);
  input.onEvent?.({ type: "final_answer", content: finalAnswer });
  return finish(finalAnswer, true, "timeout");
}

// ── LLM 调用 ─────────────────────────────────────────────

async function callLLM(
  vendorConfig: VendorConfig,
  promptLayers: PromptLayers,
  messages: ChatMessage[],
  tools: ToolSpec[],
  config: HarnessConfig,
  signal?: AbortSignal,
  onReasoningDelta?: (delta: string) => void,
): Promise<ChatResponse> {
  const adapter = getAdapterForConfig(vendorConfig);
  const composed = composePromptLayers(promptLayers, messages);
  const chatRequest: ChatRequest = {
    model: vendorConfig.model,
    messages: composed.messages,
    tools: normalizeToolSpecsForCache(tools),
    stream: true,
    maxTokens: config.reservedOutputTokens,
    promptLayers: composed.metadata,
  };

  let receivedStreamDelta = false;
  const recordResponseUsage = (response: ChatResponse): ChatResponse => {
    recordRequest(vendorConfig.model);
    if (!response.usage) return response;
    recordUsage(
      response.usage.input,
      response.usage.output,
      1,
      response.usage.cachedInput,
      vendorConfig.model,
      response.usage.cacheCreation,
    );
    return response;
  };
  try {
    return recordResponseUsage(await streamChatWithSdk({
      adapter,
      request: chatRequest,
      config: vendorConfig,
      timeoutMs: config.totalTimeoutMs,
      signal,
      onDelta: (delta) => {
        receivedStreamDelta = true;
        if (delta.type === "reasoning_delta" && delta.delta) onReasoningDelta?.(delta.delta);
      },
    }));
  } catch (error) {
    console.log(`[DIAG] streamChatWithSdk error: ${error instanceof Error ? error.message : String(error)}, receivedStreamDelta=${receivedStreamDelta}`);
    if (receivedStreamDelta || !isExplicitStreamUnsupported(error)) throw error;
  }

  // 部分兼容模型明确拒绝 stream + tools；只在零增量、明确不支持时降级，绝不重放半截流。
  console.log("[DIAG] falling back to non-stream request");
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
  const fallbackRaw = await response.json();
  const fallbackParsed = adapter.parseResponse(fallbackRaw);
  console.log(`[DIAG] fallback raw.usage=${JSON.stringify((fallbackRaw as Record<string, unknown>)?.usage ?? "(none)")}`);
  console.log(`[DIAG] fallback parsed.usage=${JSON.stringify(fallbackParsed.usage ?? "(none)")}`);
  return recordResponseUsage(fallbackParsed);
}

// ── 历史摘要（用于 mid-loop compaction）──────────────────

async function summarizeHistory(
  vendorConfig: VendorConfig,
  systemPrompt: string,
  history: ChatMessage[],
  tools: ToolSpec[],
  config: HarnessConfig,
  signal?: AbortSignal,
): Promise<string> {
  const adapter = getAdapterForConfig(vendorConfig);

  const chatRequest: ChatRequest = {
    model: vendorConfig.model,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: AGENT_COMPACTION_PROMPT },
    ],
    tools: normalizeToolSpecsForCache(tools),
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
  // 未截断的内置工具输出（例如 ask_user 的答案）仍是下一轮决策所需事实。
  // 长工具输出则必须只写入剪枝后的 preview，不能绕过截断再次注入模型上下文。
  const modelObservation = { ...observation } as Record<string, unknown>;
  if (modelObservation.truncated === true) {
    modelObservation.output = modelObservation.preview ?? modelObservation.message;
  }
  delete modelObservation.rawResult;
  delete modelObservation.toolOutputRef;
  return {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: JSON.stringify(modelObservation),
  };
}

function buildTimeoutReply(state: AgentState): string {
  const parts: string[] = [
    "抱歉，任务执行时间较长，已达到时间上限。",
    "",
    "中断原因：执行超时",
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
