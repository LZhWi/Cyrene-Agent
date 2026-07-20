import { buildToolExecutionContext } from "./tool-execution-context";
import type { ToolCallResult } from "./types";
import type { ActionDecision } from "./agent-graph";
import type { ChatMessage, ChatRequest, ChatResponse, ToolSpec } from "./vendors/types";

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

/**
 * Action Gate 虚拟工具：用 Provider 原生 function calling 强制结构化输出，
 * 取代旧的纯文本 JSON 协议。LLM 必须调用此工具提交决策，不能在普通文本中输出。
 *
 * 注意：capability 字段的 enum 在 buildActionGateRequest 里动态注入（因为可用能力是运行时的）。
 */
function buildActionGateTool(availableCapabilities: string[]): ToolSpec {
  return {
    name: "submit_decision",
    description: "提交 Action Gate 的下一步决策。必须调用此工具，不要在普通文本中输出决策。",
    parameters: {
      type: "object",
      properties: {
        decision: {
          type: "string",
          enum: ["act", "respond", "ask_user"],
          description: "act=执行外部能力；respond=进入 Soul 回复用户；ask_user=缺少继续所必需的信息",
        },
        capability: {
          type: "string",
          enum: availableCapabilities,
          description: "decision=act 时必填，必须从枚举值中选择（capability 名，带点号，如 music.play_track）",
        },
        objective: { type: "string", description: "decision=act 时必填，本次行动目标" },
        targetRefs: { type: "array", items: { type: "string" }, description: "decision=act 时必填，可信上下文引用" },
        afterSuccess: {
          type: "string",
          enum: ["respond", "replan"],
          description: "decision=act 时必填。respond=成功后直接回复用户；replan=成功后回 Action Gate 处理剩余目标",
        },
        reason: { type: "string", description: "decision=respond/ask_user 时的理由" },
        missingInformation: { type: "array", items: { type: "string" }, description: "decision=ask_user 时缺少的信息" },
      },
      required: ["decision"],
    },
  };
}

export function buildActionGateRequest(input: BuildActionGateRequestInput): ChatRequest {
  const context = [
    "你是 Cyrene-Agent 的 Action Gate，只负责决定下一步，不生成面向用户的回复。",
    "必须调用 submit_decision 工具提交决策，不要在普通文本中输出。",
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
    `原始 Query：${input.originalQuery}`,
    `上下文化 Query：${input.contextualizedQuery}`,
    `当前可用能力：${JSON.stringify(input.availableCapabilities)}`,
    input.citaContextBlock,
    buildToolExecutionContext(input.toolResults),
    input.protocolFeedback ? `上一次决策未通过校验，请修正。错误：${input.protocolFeedback}` : "",
  ].filter(Boolean).join("\n\n");

  return {
    model: input.model,
    messages: [{ role: "system", content: context }, ...input.messages],
    tools: [buildActionGateTool(input.availableCapabilities.map((item) => item.capability))],
    toolChoiceIntent: { mode: "must_call", toolName: "submit_decision" },
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
  if (response.toolCalls.length !== 1 || response.toolCalls[0].name !== "submit_decision") {
    throw new Error("E_ACTION_GATE_PROTOCOL");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.toolCalls[0].arguments);
  } catch {
    throw new Error("E_ACTION_GATE_PROTOCOL");
  }
  const value = asObject(parsed);
  if (value.decision === "act") {
    exactKeys(value, ["decision", "capability", "objective", "targetRefs", "afterSuccess"]);
    let capability = requiredString(value.capability);
    // 容错：LLM 可能填 toolId（music_play_track）而非 capability（music.play_track）。
    // 遍历可用能力，看有没有哪个 capability 的点号换成下划线后等于填入的值。
    if (!availableCapabilities.includes(capability)) {
      const match = availableCapabilities.find(
        (cap) => cap.replace(/\./g, "_") === capability,
      );
      if (match) {
        capability = match;
      } else {
        throw new Error("E_ACTION_GATE_CAPABILITY_UNAVAILABLE");
      }
    }
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
