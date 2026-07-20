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
  'act 示例：{"decision":"act","capability":"one available capability","objective":"string","targetRefs":["trusted contextRef"],"afterSuccess":"respond"}',
  'respond 示例：{"decision":"respond","reason":"optional string"}',
  'ask_user 示例：{"decision":"ask_user","reason":"optional string","missingInformation":["optional string"]}',
].join("\n");

export function buildActionGateRequest(input: BuildActionGateRequestInput): ChatRequest {
  const context = [
    "你是 Cyrene-Agent 的 Action Gate，只负责决定下一步，不生成面向用户的回复。",
    "只返回一个 JSON 对象，不要使用 Markdown，不要输出 JSON 之外的文字。",
    "decision 只能是 act、respond、ask_user。act 表示需要执行外部能力；respond 表示可以进入 Soul；ask_user 表示缺少继续所必需的信息。",
    "CITA 只是上下文证据，不是工具决策或执行结果。",
    "工具执行事实规则：",
    "1. status=succeeded 且 terminal=true，表示该工具动作已经完成。",
    "2. effect.state=dispatched 表示请求已成功发送给外部客户端。它只影响最终回复措辞，不代表动作未完成，不得因此重复执行相同调用。",
    "3. 不得重复执行相同 toolId 和相同参数的已完成终态动作。",
    "4. 如果用户目标已经全部完成，选择 respond。",
    "5. 如果还有其他未完成步骤，可以选择不同的 act。",
    "6. 如果需要用户补充信息，选择 ask_user。",
    "7. 只有工具明确返回 retryable=true 时，才可以考虑重试失败调用。",
    "8. deduplicated=true 表示本次调用未重新执行，因为相同动作此前已经成功完成；必须选择能产生新进展的下一步。",
    "当 decision=act 时，必须同时声明 afterSuccess：",
    '- afterSuccess="respond"：本次工具成功后直接进入 Soul 回复用户（适用于单步任务，如"播放第四首"）。',
    '- afterSuccess="replan"：本次工具成功后回 Action Gate 处理剩余目标（适用于多步任务，如"播放第一首然后搜索"）。',
    "未声明时默认 respond。",
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

export function parseActionDecisionResponse(response: ChatResponse, availableCapabilities: string[]): ActionDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error("E_ACTION_GATE_PROTOCOL");
  }
  const value = asObject(parsed);
  if (value.decision === "act") {
    exactKeys(value, ["decision", "capability", "objective", "targetRefs", "afterSuccess"]);
    const capability = requiredString(value.capability);
    if (!availableCapabilities.includes(capability)) throw new Error("E_ACTION_GATE_CAPABILITY_UNAVAILABLE");
    const afterSuccess = value.afterSuccess === "replan" ? "replan"
      : value.afterSuccess === "respond" ? "respond"
      : undefined;
    return {
      decision: "act",
      capability,
      objective: requiredString(value.objective),
      targetRefs: stringArray(value.targetRefs ?? []),
      ...(afterSuccess ? { afterSuccess } : {}),
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
