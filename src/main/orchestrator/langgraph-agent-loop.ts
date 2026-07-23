import { recordUsage } from "../token-usage-store";
import { stripLeakedChatTimeContext } from "../chat-time-context";
import {
  buildActionGateRequest,
  parseActionDecisionResponse,
  ActionGateProtocolError,
  type ActionCapability,
} from "./action-gate";
import { runAgentGraph, type AgentGraphState } from "./agent-graph";
import { AgentRuntimeError } from "./agent-runtime-error";
import {
  resolveActionGateProfile,
  resolveActionGateReasoningFromSettings,
  selectActionGateStrategy,
} from "./vendors/action-gate-profiles";
import { ExecutionLedger } from "./execution-ledger";
import { resolveNativeToolCall } from "./native-function-calling";
import { normalizeToolExecutionOutcome } from "./tool-outcome-normalizer";
import {
  parseAndValidateToolCallArguments,
  resolveToolForCapability,
} from "./tool-argument-validator";
import { buildToolExecutionContext, buildExecutionBrief } from "./tool-execution-context";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult, ToolExecutionOutcome } from "./types";
import type { TwoPhaseEvent, TwoPhaseFcResult, AgentLoopSettings } from "./two-phase-fc-loop";
import type { ChatMessage, ChatRequest, ChatVendorAdapter, ToolCall } from "./vendors/types";
import { perf } from "../perf-trace";
import { contextRefRegistry } from "./tool-context";

export interface LangGraphAgentLoopOptions {
  settings: AgentLoopSettings;
  adapter: ChatVendorAdapter;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  toolSystemContent: string;
  soulSystemBaseContent: string;
  originalQuery: string;
  contextualizedQuery: string;
  citaContextBlock: string;
  timeoutMs: number;
  maxIterations?: number;
  imageCaptionFallback?: () => Promise<ChatMessage[]>;
  executeTool: (tc: ToolCall, runnableToolIds: Set<string>) => Promise<string | ToolExecutionOutcome>;
  executionLedger?: ExecutionLedger;
  onEvent?: (event: TwoPhaseEvent) => void;
  recordUsage?: (input: number, output: number, calls: number) => void;
  signal?: AbortSignal;
  cleanMessages?: ChatMessage[];
  actionGateSystemPrompt?: string;
  nativeFcSystemContent?: string;
  responseContext?: string;
  conversationId?: string;
}

const LOG_PREFIX = "[AgentGraph/Trace]";

async function callAdapter(
  adapter: ChatVendorAdapter,
  request: ChatRequest,
  settings: AgentLoopSettings,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ReturnType<ChatVendorAdapter["parseResponse"]>> {
  if (signal?.aborted) throw new Error("E_AGENT_GRAPH_CANCELLED");
  const effectiveRequest = adapter.applyCacheHints?.(request, settings) ?? request;
  const http = adapter.buildRequest(effectiveRequest, settings);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const fetchTimer = perf.begin(`llm_http_fetch[${adapter.id}]`);
    const response = await fetch(http.url, {
      method: "POST",
      headers: http.headers,
      body: http.body,
      signal: controller.signal,
    });
    fetchTimer.end(`status=${response.status}`);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new AgentRuntimeError(
        "E_MODEL_REQUEST_FAILED",
        `模型请求失败：HTTP ${response.status}${body ? ` - ${body.slice(0, 200)}` : ""}`,
      );
    }
    const parseTimer = perf.begin("llm_parse_response");
    const result = adapter.parseResponse(await response.json());
    parseTimer.end();
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function emitText(onEvent: LangGraphAgentLoopOptions["onEvent"], text: string): void {
  const messageId = `msg-${Date.now()}`;
  onEvent?.({ type: "text_message_start", messageId, role: "assistant" });
  for (const char of Array.from(text)) {
    onEvent?.({ type: "text_message_content", messageId, delta: char });
  }
  onEvent?.({ type: "text_message_end", messageId });
}

function stripToolProtocol(text: string): string {
  return text
    .split("]<]minimax[>[").join("")
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/gi, "")
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .trim();
}

function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string") {
    return String((error as { code: string }).code);
  }
  const message = error instanceof Error ? error.message : String(error);
  const token = message.split(" ", 1)[0].split(":", 1)[0];
  return token.startsWith("E_") ? token : "E_TOOL_EXECUTION_FAILED";
}

function jsonResponseSummary(response: Awaited<ReturnType<ChatVendorAdapter["parseResponse"]>>): string {
  // 记录 toolCalls 信息：数量、name、arguments 是否合法 JSON
  const toolCallSummaries = response.toolCalls.map((tc) => {
    let argsStatus: string;
    try {
      JSON.parse(tc.arguments);
      argsStatus = "valid";
    } catch {
      argsStatus = "INVALID_JSON";
    }
    return { name: tc.name, argsStatus, argsChars: tc.arguments.length };
  });
  // 仍然记录 text 的解析状态（兼容文本兜底路径的诊断）
  let textKeys: string[] = [];
  try {
    const parsed = JSON.parse(response.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) textKeys = Object.keys(parsed as Record<string, unknown>);
  } catch {
    textKeys = ["<invalid-json>"];
  }
  return JSON.stringify({
    finishReason: response.finishReason,
    textChars: response.text.length,
    textKeys,
    toolCallCount: response.toolCalls.length,
    toolCalls: toolCallSummaries,
  });
}

export async function runLangGraphAgentLoop(options: LangGraphAgentLoopOptions): Promise<TwoPhaseFcResult> {
  const startedAt = Date.now();
  const perCallTimeout = Math.max(1_000, Math.min(75_000, options.timeoutMs));
  const enabledTools = options.tools.filter((tool) => tool.enabled);
  const runnableToolIds = new Set(enabledTools.map((tool) => tool.id));
  const capabilities: ActionCapability[] = enabledTools.map((tool) => ({
    capability: tool.capability ?? tool.id,
    toolId: tool.id,
    description: tool.catalogHint?.trim() || tool.description.split("\n")[0]?.trim() || tool.description,
  }));
  let usageInput = 0;
  let usageOutput = 0;
  let fallbackMessages: ChatMessage[] | undefined;
  let usedImageCaptionFallback = false;
  let duplicateTerminalStreak = 0;
  const executionLedger = options.executionLedger ?? new ExecutionLedger();
  const usageRecorder = options.recordUsage ?? ((input, output, calls) => recordUsage(input, output, calls));
  console.log(
    `${LOG_PREFIX} runtime=start adapter=${options.adapter.id} transport=${options.adapter.transport} capabilities=${capabilities.length}`,
  );

  const ensureBudget = () => {
    if (options.signal?.aborted) throw new Error("E_AGENT_GRAPH_CANCELLED");
    if (Date.now() - startedAt >= options.timeoutMs) throw new Error("E_AGENT_GRAPH_TIMEOUT");
  };
  const remainingBudget = () => {
    ensureBudget();
    return Math.max(1, options.timeoutMs - (Date.now() - startedAt));
  };
  const trackUsage = (usage?: { input: number; output: number }) => {
    if (!usage) return;
    usageInput += usage.input;
    usageOutput += usage.output;
    usageRecorder(usage.input, usage.output, 1);
  };
  const invokeWithFallback = async (
    buildRequest: (messages: ChatMessage[]) => ChatRequest,
    settingsOverride?: AgentLoopSettings,
    messagesOverride?: ChatMessage[],
  ) => {
    const activeMessages = messagesOverride ?? fallbackMessages ?? options.messages;
    const effectiveSettings = settingsOverride ?? options.settings;
    try {
      return await callAdapter(
        options.adapter,
        buildRequest(activeMessages),
        effectiveSettings,
        Math.min(perCallTimeout, remainingBudget()),
        options.signal,
      );
    } catch (error) {
      if (usedImageCaptionFallback || !options.imageCaptionFallback) throw error;
      usedImageCaptionFallback = true;
      fallbackMessages = await options.imageCaptionFallback();
      console.warn(`${LOG_PREFIX} image_fallback=true`);
      return await callAdapter(
        options.adapter,
        buildRequest(fallbackMessages),
        effectiveSettings,
        Math.min(perCallTimeout, remainingBudget()),
        options.signal,
      );
    }
  };

  const result = await perf.track("agent_graph_invoke", () => runAgentGraph({
    originalQuery: options.originalQuery,
    contextualizedQuery: options.contextualizedQuery,
    citaContextBlock: options.citaContextBlock,
    messages: options.messages,
    availableCapabilities: capabilities.map((item) => item.capability),
  }, {
    maxIterations: options.maxIterations,
    trace: (node, state) => {
      console.log(`${LOG_PREFIX} node=${node} iteration=${state.iterationCount} decision=${state.decision?.decision ?? "pending"}`);
    },
    decide: async (state) => {
      ensureBudget();
      // 异常兜底：正常路径下 routeAfterTool 已经在工具成功后确定性路由到 soul，
      // 不会走到这里。只有 routeAfterTool 路由回 decide（replan 或可重试失败）后，
      // 模型又重复同一已完成动作时才触发。主路径不依赖此检查。
      const lastResult = state.toolResults[state.toolResults.length - 1];
      if (lastResult?.deduplicated) {
        console.log(`${LOG_PREFIX} node=decide forced_respond reason=duplicate_terminal_action`);
        return { decision: "respond", reason: "duplicate_terminal_action" };
      }
      options.onEvent?.({ type: "step_started", stepName: "agent-graph-action-gate" });
      try {
        // GPT 第 2 点：先归一化 reasoning 状态为 on/off
        const requestedReasoningState = resolveActionGateReasoningFromSettings(
          options.adapter.id,
          options.settings.model,
          options.settings.reasoning,
        );
        const requestedProfile = resolveActionGateProfile({
          provider: options.adapter.id,
          transport: options.adapter.transport,
          model: options.settings.model,
          reasoning: requestedReasoningState,
        });

        // 如果 Profile 建议关 reasoning，先关（GPT 第 6 点：产品策略，非能力事实）
        const actionGateSettings = requestedProfile.reasoning.preferredForActionGate === "disable"
          && requestedProfile.reasoning.canDisablePerRequest
          ? { ...options.settings, reasoning: { mode: "off" as const } }
          : options.settings;

        // GPT 第 1 点：用关闭后的实际 reasoning 状态重新 resolve Profile + Strategy
        const effectiveReasoningState = resolveActionGateReasoningFromSettings(
          options.adapter.id,
          options.settings.model,
          actionGateSettings.reasoning,
        );
        const effectiveProfile = resolveActionGateProfile({
          provider: options.adapter.id,
          transport: options.adapter.transport,
          model: options.settings.model,
          reasoning: effectiveReasoningState,
        });
        const strategy = selectActionGateStrategy(effectiveProfile);
        console.log(`${LOG_PREFIX} node=action-gate provider=${options.adapter.id} transport=${options.adapter.transport} model=${options.settings.model} effectiveReasoning=${effectiveReasoningState} strategy=${strategy}`);

        const buildReq = (messages: ChatMessage[], protocolFeedback?: string) => buildActionGateRequest({
          model: options.settings.model,
          originalQuery: state.originalQuery,
          contextualizedQuery: state.contextualizedQuery,
          citaContextBlock: state.citaContextBlock,
          messages,
          availableCapabilities: capabilities,
          toolResults: state.toolResults,
          strategy,
          actionGateSystemPrompt: options.actionGateSystemPrompt,
          ...(protocolFeedback ? { protocolFeedback } : {}),
        });

        const response = await perf.track("decide_action_gate_llm", () => invokeWithFallback(buildReq, actionGateSettings, options.cleanMessages));
        trackUsage(response.usage);

        try {
          const decision = parseActionDecisionResponse({
            response,
            strategy,
            availableCapabilities: state.availableCapabilities,
          });
          console.log(`${LOG_PREFIX} decision=${decision.decision}${decision.decision === "act" ? ` capability=${decision.capability}` : ""}`);
          return decision;
        } catch (error) {
          // GPT 第 4 点：只捕获 ActionGateProtocolError，不 catch 网络错误等
          if (!(error instanceof ActionGateProtocolError) || !error.repairable || effectiveProfile.fallback.maxProtocolRepairs < 1) {
            throw error;
          }
          // 协议修复：全新请求，带 error.code（不是 error.message）
          console.warn(`${LOG_PREFIX} node=action-gate protocol_repair error_code=${error.code} response=${jsonResponseSummary(response)}`);
          const repairResponse = await perf.track("decide_action_gate_repair_llm", () => invokeWithFallback(
            (messages) => buildReq(messages, error.code),
            actionGateSettings,
            options.cleanMessages,
          ));
          trackUsage(repairResponse.usage);
          try {
            const decision = parseActionDecisionResponse({
              response: repairResponse,
              strategy,
              availableCapabilities: state.availableCapabilities,
            });
            console.log(`${LOG_PREFIX} decision=${decision.decision}${decision.decision === "act" ? ` capability=${decision.capability}` : ""} (after repair)`);
            return decision;
          } catch (repairError) {
            console.warn(`${LOG_PREFIX} node=action-gate protocol_repair_failed response=${jsonResponseSummary(repairResponse)}`);
            throw repairError instanceof ActionGateProtocolError
              ? repairError
              : new ActionGateProtocolError("INVALID_DECISION_SCHEMA", false);
          }
        }
      } finally {
        options.onEvent?.({ type: "step_finished", stepName: "agent-graph-action-gate" });
      }
    },
    execute: async (state, decision) => {
      ensureBudget();
      const selectedTool = resolveToolForCapability(enabledTools, decision.capability);
      options.onEvent?.({ type: "step_started", stepName: `agent-graph-tool-${selectedTool.id}` });
      try {
        // 引用验证：检查需要可信引用的工具的 targetRefs 是否有效
        const controlledInput = (selectedTool as ToolDefinition & { controlledInput?: Record<string, string> }).controlledInput;
        const needsRefVerification = controlledInput
          && Object.values(controlledInput).some((v) => v === "context_ref" || v === "context_ref_array");
        let refVerification: { verified: boolean; detail: string } | undefined;
        if (needsRefVerification && decision.targetRefs.length > 0) {
          try {
            for (const ref of decision.targetRefs) {
              contextRefRegistry.resolve(ref, options.conversationId ?? "default");
            }
            refVerification = { verified: true, detail: "" };
          } catch (error) {
            refVerification = { verified: false, detail: error instanceof Error ? error.message : String(error) };
            return [{
              toolId: selectedTool.id,
              args: {},
              output: `引用验证失败：${refVerification.detail}。需要重新搜索或获取候选列表。`,
              status: "failed",
              errorCode: "E_TRUSTED_REF_VERIFICATION_FAILED",
              terminal: false,
              retryable: true,
            }];
          }
        }

        const executionBrief = buildExecutionBrief(
          decision.objective,
          decision.targetRefs,
          state.contextualizedQuery,
          refVerification,
        );

        let args: Record<string, unknown> | undefined;
        let toolCall: ToolCall | undefined;
        let lastError: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const resolved = await resolveNativeToolCall({
              model: options.settings.model,
              nativeFcSystemPrompt: options.nativeFcSystemContent ?? "",
              executionBrief,
              toolResults: state.toolResults,
              tool: selectedTool,
              ...(lastError instanceof Error ? { protocolFeedback: lastError.message } : {}),
            }, async (request) => {
              const response = await perf.track("execute_native_tool_llm", () => invokeWithFallback(() => request));
              trackUsage(response.usage);
              return response;
            });
            args = parseAndValidateToolCallArguments(
              resolved,
              selectedTool,
              decision.targetRefs,
              state.toolResults,
            );
            toolCall = { ...resolved, arguments: JSON.stringify(args) };
            break;
          } catch (error) {
            lastError = error;
            console.warn(`${LOG_PREFIX} node=native-tool tool=${selectedTool.id} protocol_retry=${attempt} error=${errorCodeOf(error)}`);
          }
        }
        if (!args || !toolCall) throw lastError instanceof Error ? lastError : new Error("E_NATIVE_TOOL_PROTOCOL");

        const toolCallId = toolCall.id;
        options.onEvent?.({ type: "tool_call_start", toolCallId, toolCallName: selectedTool.name });
        const execution = await executionLedger.execute({
          capability: decision.capability,
          targetRefs: decision.targetRefs,
          args,
        }, async () => {
          try {
            const executed = await perf.track(`execute_tool[${selectedTool.id}]`, () => options.executeTool(toolCall, runnableToolIds));
            return typeof executed === "string" ? { status: "succeeded", output: executed } : executed;
          } catch (error) {
            return {
              status: "failed",
              errorCode: errorCodeOf(error),
              output: error instanceof Error ? error.message : String(error),
            };
          }
        });
        const outcome = normalizeToolExecutionOutcome(execution.outcome);
        const deduplicated = execution.cached && outcome.terminal;
        if (deduplicated) {
          duplicateTerminalStreak += 1;
          // 连续 2 次重复同一终态动作，说明模型没有吸收"动作已完成"的事实，提前抛错。
          if (duplicateTerminalStreak >= 2) {
            throw new AgentRuntimeError(
              "E_AGENT_NO_PROGRESS",
              "Agent repeated an already completed terminal action.",
            );
          }
        } else {
          duplicateTerminalStreak = 0;
        }
        const result: ToolCallResult = {
          toolId: selectedTool.id,
          args,
          output: outcome.output,
          status: outcome.status,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
          terminal: outcome.terminal,
          retryable: outcome.retryable,
          ...(deduplicated ? { deduplicated: true } : {}),
        };
        console.log(`${LOG_PREFIX} node=tool-result tool=${selectedTool.id} status=${outcome.status} cached=${execution.cached} deduplicated=${deduplicated}${outcome.errorCode ? ` errorCode=${outcome.errorCode}` : ""}`);
        const messageId = `tool-result-${Date.now()}`;
        options.onEvent?.({ type: "tool_call_result", toolCallId, messageId, content: outcome.output });
        options.onEvent?.({ type: "tool_call_end", toolCallId });
        return [result];
      } finally {
        options.onEvent?.({ type: "step_finished", stepName: `agent-graph-tool-${selectedTool.id}` });
      }
    },
    respond: async (state: AgentGraphState, decision) => {
      ensureBudget();
      options.onEvent?.({ type: "step_started", stepName: "agent-graph-soul" });
      try {
        const system = [
          options.soulSystemBaseContent,
          options.responseContext ?? "",
          `[ACTION_DECISION]\n${JSON.stringify(decision)}\n[/ACTION_DECISION]`,
          buildToolExecutionContext(state.toolResults),
        ].filter(Boolean).join("\n\n");
        const response = await perf.track("respond_soul_llm", () => invokeWithFallback((messages) => ({
          model: options.settings.model,
          messages: [{ role: "system", content: system }, ...messages],
          stream: false,
        })));
        trackUsage(response.usage);
        const reply = stripLeakedChatTimeContext(stripToolProtocol(response.text))
          || "刚才没有生成正常回复，请再试一次。";
        emitText(options.onEvent, reply);
        return reply;
      } finally {
        options.onEvent?.({ type: "step_finished", stepName: "agent-graph-soul" });
      }
    },
  }));

  return {
    reply: result.reply,
    toolResults: result.toolResults,
    totalUsage: usageInput || usageOutput ? { input: usageInput, output: usageOutput } : undefined,
    soulPhaseReason: "no_tool",
  };
}
