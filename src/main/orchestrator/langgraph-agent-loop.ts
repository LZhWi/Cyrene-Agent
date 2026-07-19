import { recordUsage } from "../token-usage-store";
import { stripLeakedChatTimeContext } from "../chat-time-context";
import {
  buildActionGateRequest,
  parseActionDecisionResponse,
  type ActionCapability,
} from "./action-gate";
import { runAgentGraph, type AgentGraphState } from "./agent-graph";
import { buildForcedToolRequest, parseForcedToolResponse, resolveToolForCapability } from "./forced-tool-call";
import { buildToolExecutionContext } from "./tool-execution-context";
import type { ToolDefinition } from "./tool-registry";
import type { ToolCallResult, ToolExecutionOutcome } from "./types";
import type { TwoPhaseEvent, TwoPhaseFcResult, AgentLoopSettings } from "./two-phase-fc-loop";
import type { ChatMessage, ChatRequest, ChatVendorAdapter, ToolCall } from "./vendors/types";

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
  onEvent?: (event: TwoPhaseEvent) => void;
  recordUsage?: (input: number, output: number, calls: number) => void;
  signal?: AbortSignal;
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
    const response = await fetch(http.url, {
      method: "POST",
      headers: http.headers,
      body: http.body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`模型请求失败：HTTP ${response.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    return adapter.parseResponse(await response.json());
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

function argumentsOf(toolCall: ToolCall): Record<string, unknown> {
  try {
    const value = JSON.parse(toolCall.arguments || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
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
  const usageRecorder = options.recordUsage ?? ((input, output, calls) => recordUsage(input, output, calls));

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
  ) => {
    const activeMessages = fallbackMessages ?? options.messages;
    try {
      return await callAdapter(
        options.adapter,
        buildRequest(activeMessages),
        options.settings,
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
        options.settings,
        Math.min(perCallTimeout, remainingBudget()),
        options.signal,
      );
    }
  };

  const result = await runAgentGraph({
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
      options.onEvent?.({ type: "step_started", stepName: "agent-graph-action-gate" });
      try {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const response = await invokeWithFallback((messages) => buildActionGateRequest({
            model: options.settings.model,
            originalQuery: state.originalQuery,
            contextualizedQuery: state.contextualizedQuery,
            citaContextBlock: state.citaContextBlock,
            messages,
            availableCapabilities: capabilities,
            toolResults: state.toolResults,
          }));
          trackUsage(response.usage);
          try {
            const decision = parseActionDecisionResponse(response, state.availableCapabilities);
            console.log(`${LOG_PREFIX} decision=${decision.decision}${decision.decision === "act" ? ` capability=${decision.capability}` : ""}`);
            return decision;
          } catch (error) {
            lastError = error;
            console.warn(`${LOG_PREFIX} node=action-gate protocol_retry=${attempt}`);
          }
        }
        throw lastError instanceof Error ? lastError : new Error("E_ACTION_GATE_PROTOCOL");
      } finally {
        options.onEvent?.({ type: "step_finished", stepName: "agent-graph-action-gate" });
      }
    },
    execute: async (state, decision) => {
      ensureBudget();
      const selectedTool = resolveToolForCapability(enabledTools, decision.capability);
      options.onEvent?.({ type: "step_started", stepName: `agent-graph-tool-${selectedTool.id}` });
      try {
        let toolCall: ToolCall | undefined;
        let lastError: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const response = await invokeWithFallback((messages) => buildForcedToolRequest({
            model: options.settings.model,
            messages,
            toolSystemContent: options.toolSystemContent,
            citaContextBlock: state.citaContextBlock,
            decision,
            toolResults: state.toolResults,
            tool: selectedTool,
          }));
          trackUsage(response.usage);
          try {
            toolCall = parseForcedToolResponse(response, selectedTool.id);
            break;
          } catch (error) {
            lastError = error;
            console.warn(`${LOG_PREFIX} node=force-tool tool=${selectedTool.id} protocol_retry=${attempt}`);
          }
        }
        if (!toolCall) throw lastError instanceof Error ? lastError : new Error("E_FORCED_TOOL_PROTOCOL");

        const toolCallId = toolCall.id || `${selectedTool.id}-${Date.now()}`;
        options.onEvent?.({ type: "tool_call_start", toolCallId, toolCallName: selectedTool.name });
        let outcome: ToolExecutionOutcome;
        try {
          const executed = await options.executeTool(toolCall, runnableToolIds);
          outcome = typeof executed === "string" ? { status: "succeeded", output: executed } : executed;
        } catch (error) {
          outcome = {
            status: "failed",
            errorCode: errorCodeOf(error),
            output: error instanceof Error ? error.message : String(error),
          };
        }
        const result: ToolCallResult = {
          toolId: selectedTool.id,
          args: argumentsOf(toolCall),
          output: outcome.output,
          status: outcome.status,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        };
        console.log(`${LOG_PREFIX} node=tool-result tool=${selectedTool.id} status=${outcome.status}${outcome.errorCode ? ` errorCode=${outcome.errorCode}` : ""}`);
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
          `[ACTION_DECISION]\n${JSON.stringify(decision)}\n[/ACTION_DECISION]`,
          buildToolExecutionContext(state.toolResults),
        ].join("\n\n");
        const response = await invokeWithFallback((messages) => ({
          model: options.settings.model,
          messages: [{ role: "system", content: system }, ...messages],
          stream: false,
        }));
        trackUsage(response.usage);
        const reply = stripLeakedChatTimeContext(stripToolProtocol(response.text))
          || "刚才没有生成正常回复，请再试一次。";
        emitText(options.onEvent, reply);
        return reply;
      } finally {
        options.onEvent?.({ type: "step_finished", stepName: "agent-graph-soul" });
      }
    },
  });

  return {
    reply: result.reply,
    toolResults: result.toolResults,
    totalUsage: usageInput || usageOutput ? { input: usageInput, output: usageOutput } : undefined,
    soulPhaseReason: "no_tool",
  };
}
