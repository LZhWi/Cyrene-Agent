import { buildToolExecutionContext } from "./tool-execution-context";
import type { ToolCallResult } from "./types";
import type { ActionDecision } from "./agent-graph";
import type { ActionGateStrategy } from "./vendors/action-gate-profiles";
import type { ChatMessage, ChatRequest, ChatResponse, ToolSpec, ToolChoiceOverride } from "./vendors/types";

// ── 结构化协议错误（GPT 第 4 点）─────────────────────────

export type ActionGateProtocolErrorCode =
  | "MISSING_DECISION_TOOL_CALL"
  | "MULTIPLE_DECISION_TOOL_CALLS"
  | "UNEXPECTED_TOOL_NAME"
  | "INVALID_TOOL_ARGUMENTS_JSON"
  | "INVALID_DECISION_SCHEMA"
  | "CAPABILITY_UNAVAILABLE"
  | "INVALID_TEXT_JSON"
  | "UNEXPECTED_TOOL_CALL_IN_TEXT_MODE";

export class ActionGateProtocolError extends Error {
  constructor(readonly code: ActionGateProtocolErrorCode, readonly repairable: boolean = true) {
    super("E_ACTION_GATE_PROTOCOL");
    this.name = "ActionGateProtocolError";
  }
}

// ── 类型 ─────────────────────────────────────────────────

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
  strategy: ActionGateStrategy;
  protocolFeedback?: string;
}

const SUBMIT_DECISION_TOOL_NAME = "submit_decision";

// ── 虚拟工具 schema ──────────────────────────────────────

function buildActionGateTool(availableCapabilities: string[]): ToolSpec {
  return {
    name: SUBMIT_DECISION_TOOL_NAME,
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

// ── 协议修复 Prompt（GPT 第 3 点：按 strategy 分）─────────

function buildProtocolFeedback(strategy: ActionGateStrategy, errorCode: string): string {
  const base = `上一次决策未通过协议校验。错误类型：${errorCode}`;
  let instruction: string;
  switch (strategy) {
    case "named_decision_tool":
    case "required_single_decision_tool":
      instruction = "只提交一个 submit_decision 工具调用。不得输出普通文本。";
      break;
    case "auto_single_decision_tool_with_json_fallback":
    case "omit_tool_choice_with_json_fallback":
      instruction = "优先提交一个 submit_decision 工具调用。如果未调用工具，只能输出一个完整 JSON 对象。不得输出解释或 Markdown。";
      break;
    case "plain_json_text":
      instruction = "只输出一个完整 JSON 对象。不得调用工具，不得输出解释或 Markdown。";
      break;
  }
  return `${base}\n${instruction}`;
}

// ── 请求构建 ─────────────────────────────────────────────

export function buildActionGateRequest(input: BuildActionGateRequestInput): ChatRequest {
  const context = [
    "你是 Cyrene-Agent 的 Action Gate，只负责决定下一步，不生成面向用户的回复。",
    input.strategy === "plain_json_text"
      ? "只输出一个 JSON 对象，不要使用 Markdown，不要输出 JSON 之外的文字。"
      : "必须调用 submit_decision 工具提交决策，不要在普通文本中输出。",
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
    input.protocolFeedback ? buildProtocolFeedback(input.strategy, input.protocolFeedback) : "",
  ].filter(Boolean).join("\n\n");

  // 按 strategy 构建 tools + toolChoiceOverride（GPT 第 2/3 点）
  const useTools = input.strategy !== "plain_json_text";
  const toolChoiceOverride = buildToolChoiceOverride(input.strategy);

  return {
    model: input.model,
    messages: [{ role: "system", content: context }, ...input.messages],
    ...(useTools ? { tools: [buildActionGateTool(input.availableCapabilities.map((item) => item.capability))] } : {}),
    ...(toolChoiceOverride ? { toolChoiceOverride } : {}),
    stream: false,
  };
}

function buildToolChoiceOverride(strategy: ActionGateStrategy): ToolChoiceOverride | undefined {
  switch (strategy) {
    case "named_decision_tool":
      return { kind: "named", toolName: SUBMIT_DECISION_TOOL_NAME };
    case "required_single_decision_tool":
      return { kind: "required" };
    case "auto_single_decision_tool_with_json_fallback":
      return { kind: "auto" };
    case "omit_tool_choice_with_json_fallback":
      return { kind: "omit" };
    case "plain_json_text":
      return undefined;
  }
}

// ── 校验辅助 ─────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ActionGateProtocolError("INVALID_DECISION_SCHEMA");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new ActionGateProtocolError("INVALID_DECISION_SCHEMA");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new ActionGateProtocolError("INVALID_DECISION_SCHEMA");
  return value as string[];
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ActionGateProtocolError("INVALID_DECISION_SCHEMA");
  return value.trim();
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

// ── 决策值解析（所有路径复用）────────────────────────────

function parseDecisionValue(value: unknown, availableCapabilities: string[]): ActionDecision {
  const obj = asObject(value);
  if (obj.decision === "act") {
    exactKeys(obj, ["decision", "capability", "objective", "targetRefs", "afterSuccess"]);
    let capability = requiredString(obj.capability);
    // 容错：LLM 可能填 toolId（music_play_track）而非 capability（music.play_track）
    if (!availableCapabilities.includes(capability)) {
      const match = availableCapabilities.find((cap) => cap.replace(/\./g, "_") === capability);
      if (match) {
        capability = match;
      } else {
        throw new ActionGateProtocolError("CAPABILITY_UNAVAILABLE");
      }
    }
    const afterSuccess = obj.afterSuccess === "replan" ? "replan"
      : obj.afterSuccess === "respond" ? "respond"
      : undefined;
    return {
      decision: "act",
      capability,
      objective: requiredString(obj.objective),
      targetRefs: stringArray(obj.targetRefs ?? []),
      ...(afterSuccess ? { afterSuccess } : {}),
    };
  }
  if (obj.decision === "respond") {
    exactKeys(obj, ["decision", "reason"]);
    return { decision: "respond", reason: optionalString(obj.reason, "ready_to_respond") };
  }
  if (obj.decision === "ask_user") {
    exactKeys(obj, ["decision", "reason", "missingInformation"]);
    return {
      decision: "ask_user",
      reason: optionalString(obj.reason, "missing_information"),
      missingInformation: obj.missingInformation === undefined ? [] : stringArray(obj.missingInformation),
    };
  }
  throw new ActionGateProtocolError("INVALID_DECISION_SCHEMA");
}

// ── 响应解析（GPT 第 5 点：四类路径，按 strategy）─────────

export interface ParseActionDecisionInput {
  response: ChatResponse;
  strategy: ActionGateStrategy;
  availableCapabilities: string[];
}

export function parseActionDecisionResponse(input: ParseActionDecisionInput): ActionDecision {
  const { response, strategy, availableCapabilities } = input;
  const toolCalls = response.toolCalls;
  const isForcedMode = strategy === "named_decision_tool" || strategy === "required_single_decision_tool";
  const isBestEffortMode = strategy === "auto_single_decision_tool_with_json_fallback" || strategy === "omit_tool_choice_with_json_fallback";
  const isTextOnlyMode = strategy === "plain_json_text";

  // plain_json_text：必须没有 ToolCall，必须有合法 JSON text（GPT 第 5 点）
  if (isTextOnlyMode) {
    if (toolCalls.length > 0) {
      throw new ActionGateProtocolError("UNEXPECTED_TOOL_CALL_IN_TEXT_MODE");
    }
    return parseTextJson(response.text, availableCapabilities);
  }

  // 强制模式（named/required）：必须恰好 1 个 submit_decision ToolCall，不允许文本兜底
  if (isForcedMode) {
    if (toolCalls.length === 0) {
      throw new ActionGateProtocolError("MISSING_DECISION_TOOL_CALL");
    }
    return parseToolCall(toolCalls, availableCapabilities);
  }

  // best-effort 模式（auto/omit）：优先 ToolCall，无 ToolCall 时允许文本兜底
  if (isBestEffortMode) {
    if (toolCalls.length > 0) {
      return parseToolCall(toolCalls, availableCapabilities);
    }
    return parseTextJson(response.text, availableCapabilities);
  }

  // 理论上不会到这里
  throw new ActionGateProtocolError("INVALID_DECISION_SCHEMA", false);
}

/** 解析 ToolCall 路径：校验 name + arguments */
function parseToolCall(toolCalls: ChatResponse["toolCalls"], availableCapabilities: string[]): ActionDecision {
  // 过滤出 submit_decision 调用
  const decisionCalls = toolCalls.filter((tc) => tc.name === SUBMIT_DECISION_TOOL_NAME);
  if (decisionCalls.length === 0) {
    throw new ActionGateProtocolError("UNEXPECTED_TOOL_NAME");
  }
  if (decisionCalls.length > 1) {
    throw new ActionGateProtocolError("MULTIPLE_DECISION_TOOL_CALLS");
  }
  // 如果有非 submit_decision 的 ToolCall，也视为协议错误
  if (toolCalls.length > decisionCalls.length) {
    throw new ActionGateProtocolError("UNEXPECTED_TOOL_NAME");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decisionCalls[0].arguments);
  } catch {
    throw new ActionGateProtocolError("INVALID_TOOL_ARGUMENTS_JSON");
  }
  return parseDecisionValue(parsed, availableCapabilities);
}

/** 解析文本 JSON 路径 */
function parseTextJson(text: string, availableCapabilities: string[]): ActionDecision {
  if (!text || text.trim().length === 0) {
    throw new ActionGateProtocolError("INVALID_TEXT_JSON");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ActionGateProtocolError("INVALID_TEXT_JSON");
  }
  return parseDecisionValue(parsed, availableCapabilities);
}
