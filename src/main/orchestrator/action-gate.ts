import { buildToolExecutionContext } from "./tool-execution-context";
import type { ToolCallResult } from "./types";
import type { ActionDecision } from "./agent-graph";
import type { ChatMessage, ChatRequest, ChatResponse } from "./vendors/types";

export interface ActionCapability {
  capability: string;
  toolId: string;
  description: string;
}

export interface BuildActionGateRequestInput {
  model: string;
  originalQuery: string;
  contextualizedQuery: string;
  citaContextBlock: string;
  messages: ChatMessage[];
  availableCapabilities: ActionCapability[];
  toolResults: ToolCallResult[];
  protocolFeedback?: string;
}

const OUTPUT_EXAMPLES = [
  'act 示例：{"decision":"act","capability":"one available capability","objective":"string","targetRefs":["trusted contextRef"]}',
  'respond 示例：{"decision":"respond","reason":"optional string"}',
  'ask_user 示例：{"decision":"ask_user","reason":"optional string","missingInformation":["optional string"]}',
].join("\n");

export function buildActionGateRequest(input: BuildActionGateRequestInput): ChatRequest {
  const context = [
    "你是 Cyrene-Agent 的 Action Gate，只负责决定下一步，不生成面向用户的回复。",
    "只返回一个 JSON 对象，不要使用 Markdown，不要输出 JSON 之外的文字。",
    "decision 只能是 act、respond、ask_user。act 表示需要执行外部能力；respond 表示可以进入 Soul；ask_user 表示缺少继续所必需的信息。",
    "CITA 只是上下文证据，不是工具决策或执行结果。只要目标仍依赖外部数据或副作用且没有成功工具证据，就不能 respond。",
    "合法示例只能三选一；不要把 act、respond 或 ask_user 用作顶层包装键。",
    OUTPUT_EXAMPLES,
    `原始 Query：${input.originalQuery}`,
    `上下文化 Query：${input.contextualizedQuery}`,
    `当前可用能力：${JSON.stringify(input.availableCapabilities)}`,
    input.citaContextBlock,
    buildToolExecutionContext(input.toolResults),
    input.protocolFeedback ? `上一次 JSON 决策无效，请修正。错误：${input.protocolFeedback}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    model: input.model,
    messages: [{ role: "system", content: context }, ...input.messages],
    stream: false,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("E_ACTION_GATE_PROTOCOL");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error("E_ACTION_GATE_PROTOCOL");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("E_ACTION_GATE_PROTOCOL");
  return value as string[];
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("E_ACTION_GATE_PROTOCOL");
  return value.trim();
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeDecisionEnvelope(parsed: unknown): Record<string, unknown> {
  const value = asObject(parsed);
  if (typeof value.decision === "string") return value;
  const keys = Object.keys(value);
  if (keys.length !== 1 || !["act", "respond", "ask_user"].includes(keys[0])) {
    throw new Error("E_ACTION_GATE_PROTOCOL");
  }
  const decision = keys[0];
  const payload = asObject(value[decision]);
  if (payload.decision !== undefined && payload.decision !== decision) throw new Error("E_ACTION_GATE_PROTOCOL");
  return { ...payload, decision };
}

export function parseActionDecisionResponse(response: ChatResponse, availableCapabilities: string[]): ActionDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("E_ACTION_GATE_PROTOCOL");
  }
  const value = normalizeDecisionEnvelope(parsed);
  if (value.decision === "act") {
    exactKeys(value, ["decision", "capability", "objective", "targetRefs"]);
    const capability = requiredString(value.capability);
    if (!availableCapabilities.includes(capability)) throw new Error("E_ACTION_GATE_CAPABILITY_UNAVAILABLE");
    return {
      decision: "act",
      capability,
      objective: requiredString(value.objective),
      targetRefs: stringArray(value.targetRefs ?? []),
    };
  }
  if (value.decision === "respond") {
    exactKeys(value, ["decision", "reason"]);
    return { decision: "respond", reason: optionalString(value.reason, "ready_to_respond") };
  }
  if (value.decision === "ask_user") {
    exactKeys(value, ["decision", "reason", "missingInformation"]);
    return {
      decision: "ask_user",
      reason: optionalString(value.reason, "missing_information"),
      missingInformation: value.missingInformation === undefined ? [] : stringArray(value.missingInformation),
    };
  }
  throw new Error("E_ACTION_GATE_PROTOCOL");
}
