import { runProactiveStages, sameProactiveModel } from "./proactive-stages";
import { resolveChatModuleModel } from "../settings/chat-module-routes";
import { recordUsage, recordRequest } from "../token-usage-store";
import {
  getAdapterForConfig,
  type ChatMessage,
  type VendorConfig,
} from "../orchestrator/vendors";
import { parseProactiveDecision, type ProactiveModelDecision } from "./proactive-prompt";

export type ProactiveModelResult =
  | ProactiveModelDecision
  | { kind: "error"; reason: string };

export interface RunProactiveModelInput {
  settings: VendorConfig;
  messages: ChatMessage[];
  timeoutMs: number;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

function containsToolContent(messages: ChatMessage[]): boolean {
  return messages.some((message) => (
    message.role === "tool" ||
    Boolean(message.toolCallId) ||
    Boolean(message.toolCalls?.length)
  ));
}

export async function runProactiveModel(input: RunProactiveModelInput): Promise<ProactiveModelResult> {
  if (containsToolContent(input.messages)) {
    return { kind: "error", reason: "tool_content_forbidden" };
  }

  const content = resolveChatModuleModel("proactive", input.settings);
  const decision = resolveChatModuleModel("proactiveDecision", input.settings);
  const started = Date.now();
  let failure: ProactiveModelResult | undefined;
  try {
    const text = await runProactiveStages(sameProactiveModel(content, decision), async (stage, instruction) => {
      const remaining = input.timeoutMs - (Date.now() - started);
      if (remaining <= 0) { failure = { kind: "error", reason: "timeout" }; throw new Error("timeout"); }
      const result = await requestProactiveModel({ ...input, timeoutMs: remaining, settings: stage === "decision" ? decision : content,
        messages: instruction ? [...input.messages, { role: "system", content: instruction }] : input.messages });
      if (!("text" in result)) { failure = result; throw new Error("request_failed"); }
      return result.text;
    }, input.signal);
    return parseProactiveDecision(text);
  } catch (error) { return failure ?? { kind: "error", reason: input.signal?.aborted ? "cancelled" : "network_error" }; }
}

async function requestProactiveModel(input: RunProactiveModelInput): Promise<{ text: string } | ProactiveModelResult> {
  const adapter = getAdapterForConfig(input.settings);
  const request = adapter.buildRequest({
    model: input.settings.model,
    messages: input.messages,
    stream: false,
    maxTokens: 600,
  }, input.settings);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, input.timeoutMs));
  try {
    const response = await (input.fetchFn ?? fetch)(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
    });
    if (!response.ok) return { kind: "error", reason: `http_${response.status}` };

    const raw = await response.json();
    let parsedResponse;
    try {
      parsedResponse = adapter.parseResponse(raw);
    } catch {
      return { kind: "invalid", reason: "invalid_provider_response" };
    }
    recordRequest(input.settings.model);
    if (parsedResponse.usage) {
      recordUsage(parsedResponse.usage.input, parsedResponse.usage.output, 1, parsedResponse.usage.cachedInput, input.settings.model, parsedResponse.usage.cacheCreation);
    }
    return { text: parsedResponse.text ?? "" };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { kind: "error", reason: name === "AbortError" ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}
