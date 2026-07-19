import { buildToolExecutionContext } from "./tool-execution-context";
import type { ToolCallResult } from "./types";
import type { ActionDecision } from "./agent-graph";
import type { ChatMessage, ChatRequest, ChatResponse } from "./vendors/types";

export const ACTION_DECISION_TOOL_ID = "submit_action_decision";

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
}

export function buildActionGateRequest(input: BuildActionGateRequestInput): ChatRequest {
  const context = [
    "你是 Cyrene-Agent 的 Action Gate，只负责决定下一步，不生成面向用户的回复。",
    "必须调用 submit_action_decision，并且只能输出 act、respond、ask_user 之一。",
    "act 表示必须执行外部工具；respond 表示当前可以进入 Soul 回复；ask_user 表示缺少继续执行所必需的信息。",
    "CITA 是上下文证据，不是执行结果。只要用户目标仍需要外部数据或副作用且尚无成功工具证据，就不能选择 respond。",
    `原始 Query：${input.originalQuery}`,
    `上下文化 Query：${input.contextualizedQuery}`,
    `当前可用能力：${JSON.stringify(input.availableCapabilities)}`,
    input.citaContextBlock,
    buildToolExecutionContext(input.toolResults),
  ].filter(Boolean).join("\n\n");

  return {
    model: input.model,
    messages: [{ role: "system", content: context }, ...input.messages],
    tools: [{
      name: ACTION_DECISION_TOOL_ID,
      description: "提交下一步结构化行动决策。",
      parameters: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["act", "respond", "ask_user"] },
          capability: { type: "string", description: "act 时选择当前可用能力之一" },
          objective: { type: "string", description: "act 时说明本次工具行动目标" },
          targetRefs: { type: "array", items: { type: "string" }, description: "CITA 提供的可信引用" },
          reason: { type: "string", description: "respond 或 ask_user 的内部理由" },
          missingInformation: { type: "array", items: { type: "string" }, description: "ask_user 时缺少的信息" },
        },
        required: ["decision"],
      },
    }],
    toolChoice: { name: ACTION_DECISION_TOOL_ID },
    stream: false,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("E_ACTION_GATE_PROTOCOL");
  }
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("E_ACTION_GATE_PROTOCOL");
  }
  return value as string[];
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("E_ACTION_GATE_PROTOCOL");
  }
  return value.trim();
}

export function parseActionDecisionResponse(
  response: ChatResponse,
  availableCapabilities: string[],
): ActionDecision {
  if (response.toolCalls.length !== 1 || response.toolCalls[0].name !== ACTION_DECISION_TOOL_ID) {
    throw new Error("E_ACTION_GATE_PROTOCOL");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.toolCalls[0].arguments || "{}");
  } catch {
    throw new Error("E_ACTION_GATE_PROTOCOL");
  }
  const value = asObject(parsed);
  if (value.decision === "act") {
    const capability = requiredString(value.capability);
    if (!availableCapabilities.includes(capability)) {
      throw new Error("E_ACTION_GATE_CAPABILITY_UNAVAILABLE");
    }
    return {
      decision: "act",
      capability,
      objective: requiredString(value.objective),
      targetRefs: stringArray(value.targetRefs ?? []),
    };
  }
  if (value.decision === "respond") {
    return { decision: "respond", reason: requiredString(value.reason) };
  }
  if (value.decision === "ask_user") {
    return {
      decision: "ask_user",
      reason: requiredString(value.reason),
      missingInformation: stringArray(value.missingInformation),
    };
  }
  throw new Error("E_ACTION_GATE_PROTOCOL");
}
