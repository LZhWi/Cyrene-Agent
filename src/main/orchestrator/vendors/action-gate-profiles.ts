/**
 * Action Gate 多厂商能力 Profile 系统。
 *
 * 设计原则（GPT 审查要求）：
 * 1. 厂商差异放进数据 Profile，策略函数只读 Profile，不认 providerId。
 * 2. `omit` 不是 tool_choice mode，用 `parameterAccepted: false` + `behaviorWhenOmitted` 表达。
 * 3. `auto` 不等于 `must_call`，策略名体现可靠等级。
 * 4. `transport === "anthropic"` 不等于 Claude，Profile 按 provider+transport+reasoning 匹配。
 * 5. reasoning 关闭是产品策略，用 `preferredForActionGate` 表达，不按厂商名 if/else。
 * 6. 未知 Provider 默认走 `plain_json_text`，不假定支持 auto。
 *
 * 事实来源：docs/vendors/tool-calling-matrix.md
 */
import {
  resolveEffectiveReasoning,
  resolveReasoningCapability,
  type ReasoningCapability,
  type ReasoningPreference,
} from "../../../shared/reasoning";
import type { Transport } from "./types";

// ── Profile 数据结构 ──────────────────────────────────────

export interface ActionGateCapabilityProfile {
  toolChoice: {
    /** 是否允许发送 tool_choice 字段。DeepSeek thinking on 时为 false（拒绝整个字段）。 */
    parameterAccepted: boolean;
    /** 支持的 tool_choice 值（API 语义，不含 omit）。 */
    modes: Array<"none" | "auto" | "required" | "named">;
    /** 省略 tool_choice 字段时的行为。DeepSeek thinking on 省略后仍类似 auto。 */
    behaviorWhenOmitted: "auto" | "unknown";
  };
  reasoning: {
    /** thinking 是否可按请求关闭。 */
    canDisablePerRequest: boolean;
    /** Action Gate 的产品策略偏好：保留还是关闭 reasoning。 */
    preferredForActionGate: "preserve" | "disable";
  };
  toolCalling: {
    /** thinking on 时 tool_call 是否可靠。MiMo 待契约测试。 */
    reliableWithReasoning: boolean | "contract_test_required";
    /** 多轮工具调用是否必须回传 reasoning_content。 */
    requiresReasoningReplay: boolean;
  };
  fallback: {
    /** 是否允许文本 JSON 兜底（provider 只支持 auto 时需要）。 */
    jsonText: boolean;
    /** 协议修复请求最大次数。 */
    maxProtocolRepairs: number;
  };
}

export type ActionGateStrategy =
  | "named_decision_tool"
  | "required_single_decision_tool"
  | "auto_single_decision_tool_with_json_fallback"
  | "omit_tool_choice_with_json_fallback"
  | "plain_json_text";

// ── Profile 匹配 ─────────────────────────────────────────

interface ProfileMatch {
  provider?: string;
  transport?: Transport;
  modelPattern?: RegExp;
  reasoning?: "on" | "off";
}

interface ProfileDefinition {
  match: ProfileMatch;
  profile: ActionGateCapabilityProfile;
}

// ── Profile 表（从具体到默认）────────────────────────────

// 完整支持 named/required/auto/none 的 Profile（thinking off 时用）
const FULL_PROFILE: ActionGateCapabilityProfile = {
  toolChoice: { parameterAccepted: true, modes: ["named", "required", "auto", "none"], behaviorWhenOmitted: "auto" },
  reasoning: { canDisablePerRequest: true, preferredForActionGate: "preserve" },
  toolCalling: { reliableWithReasoning: true, requiresReasoningReplay: false },
  fallback: { jsonText: false, maxProtocolRepairs: 1 },
};

// 只有 auto 的 Profile（GLM/MiniMax/MiMo thinking off）
const AUTO_ONLY_PROFILE: ActionGateCapabilityProfile = {
  toolChoice: { parameterAccepted: true, modes: ["auto"], behaviorWhenOmitted: "auto" },
  reasoning: { canDisablePerRequest: true, preferredForActionGate: "preserve" },
  toolCalling: { reliableWithReasoning: true, requiresReasoningReplay: false },
  fallback: { jsonText: true, maxProtocolRepairs: 1 },
};

// 默认 Profile（未知 Provider）：不假定支持 auto，走纯文本 JSON
const DEFAULT_PROFILE: ActionGateCapabilityProfile = {
  toolChoice: { parameterAccepted: false, modes: [], behaviorWhenOmitted: "unknown" },
  reasoning: { canDisablePerRequest: false, preferredForActionGate: "preserve" },
  toolCalling: { reliableWithReasoning: "contract_test_required", requiresReasoningReplay: false },
  fallback: { jsonText: true, maxProtocolRepairs: 1 },
};

const PROFILES: ProfileDefinition[] = [
  // ── DeepSeek ──
  {
    match: { provider: "deepseek", reasoning: "on" },
    profile: {
      toolChoice: { parameterAccepted: false, modes: [], behaviorWhenOmitted: "auto" },
      reasoning: { canDisablePerRequest: true, preferredForActionGate: "disable" },
      toolCalling: { reliableWithReasoning: false, requiresReasoningReplay: true },
      fallback: { jsonText: true, maxProtocolRepairs: 1 },
    },
  },
  { match: { provider: "deepseek", reasoning: "off" }, profile: FULL_PROFILE },

  // ── Claude (Anthropic 原厂) ──
  {
    match: { provider: "claude", reasoning: "on" },
    profile: {
      toolChoice: { parameterAccepted: true, modes: ["auto", "none"], behaviorWhenOmitted: "auto" },
      reasoning: { canDisablePerRequest: true, preferredForActionGate: "disable" },
      toolCalling: { reliableWithReasoning: true, requiresReasoningReplay: true },
      fallback: { jsonText: true, maxProtocolRepairs: 1 },
    },
  },
  { match: { provider: "claude", reasoning: "off" }, profile: FULL_PROFILE },

  // ── Kimi ──
  {
    match: { provider: "kimi", reasoning: "on" },
    profile: {
      // thinking on: named 不可用，required 仍可用
      toolChoice: { parameterAccepted: true, modes: ["required", "auto", "none"], behaviorWhenOmitted: "auto" },
      reasoning: { canDisablePerRequest: true, preferredForActionGate: "preserve" },
      toolCalling: { reliableWithReasoning: true, requiresReasoningReplay: true },
      fallback: { jsonText: false, maxProtocolRepairs: 1 },
    },
  },
  { match: { provider: "kimi", reasoning: "off" }, profile: FULL_PROFILE },

  // ── Qwen ──
  {
    match: { provider: "qwen", reasoning: "on" },
    profile: {
      toolChoice: { parameterAccepted: true, modes: ["auto", "none"], behaviorWhenOmitted: "auto" },
      reasoning: { canDisablePerRequest: true, preferredForActionGate: "disable" },
      toolCalling: { reliableWithReasoning: true, requiresReasoningReplay: true },
      fallback: { jsonText: true, maxProtocolRepairs: 1 },
    },
  },
  { match: { provider: "qwen", reasoning: "off" }, profile: FULL_PROFILE },

  // ── ChatGPT (OpenAI) ── 完整支持，thinking 无已知限制
  { match: { provider: "chatgpt" }, profile: FULL_PROFILE },

  // ── GLM ── 永远 auto
  {
    match: { provider: "glm" },
    profile: {
      ...AUTO_ONLY_PROFILE,
      toolCalling: { reliableWithReasoning: true, requiresReasoningReplay: true },
    },
  },

  // ── MiniMax ── 永远 auto
  { match: { provider: "minimax" }, profile: AUTO_ONLY_PROFILE },

  // ── MiMo ──
  {
    match: { provider: "mimo", reasoning: "on" },
    profile: {
      toolChoice: { parameterAccepted: true, modes: ["auto"], behaviorWhenOmitted: "auto" },
      reasoning: { canDisablePerRequest: true, preferredForActionGate: "disable" },
      // thinking on 时 tool_call 稳定性待契约测试
      toolCalling: { reliableWithReasoning: "contract_test_required", requiresReasoningReplay: true },
      fallback: { jsonText: true, maxProtocolRepairs: 1 },
    },
  },
  { match: { provider: "mimo", reasoning: "off" }, profile: AUTO_ONLY_PROFILE },

  // ── Volcengine ── 待契约测试，保守 auto
  {
    match: { provider: "volcengine" },
    profile: {
      ...AUTO_ONLY_PROFILE,
      toolCalling: { reliableWithReasoning: "contract_test_required", requiresReasoningReplay: false },
    },
  },

  // ── 默认（未知 Provider）── 不假定支持 auto
  { match: {}, profile: DEFAULT_PROFILE },
];

// ── 解析函数 ──────────────────────────────────────────────

export interface ActionGateProfileContext {
  provider: string;
  transport: Transport;
  model: string;
  reasoning: "on" | "off";
}

/** 遍历 Profile 表，返回第一个 match 的 Profile。 */
export function resolveActionGateProfile(context: ActionGateProfileContext): ActionGateCapabilityProfile {
  for (const def of PROFILES) {
    const m = def.match;
    if (m.provider !== undefined && m.provider !== context.provider) continue;
    if (m.transport !== undefined && m.transport !== context.transport) continue;
    if (m.modelPattern !== undefined && !m.modelPattern.test(context.model)) continue;
    if (m.reasoning !== undefined && m.reasoning !== context.reasoning) continue;
    return def.profile;
  }
  return DEFAULT_PROFILE;
}

/**
 * 策略选择器：纯函数，只读 Profile，不认厂商名字。
 *
 * 优先级：named > required > auto > omit > plain_json_text
 */
export function selectActionGateStrategy(profile: ActionGateCapabilityProfile): ActionGateStrategy {
  if (profile.toolChoice.parameterAccepted && profile.toolChoice.modes.includes("named")) {
    return "named_decision_tool";
  }
  if (profile.toolChoice.parameterAccepted && profile.toolChoice.modes.includes("required")) {
    return "required_single_decision_tool";
  }
  if (profile.toolChoice.parameterAccepted && profile.toolChoice.modes.includes("auto")) {
    return "auto_single_decision_tool_with_json_fallback";
  }
  if (profile.toolChoice.behaviorWhenOmitted === "auto") {
    return "omit_tool_choice_with_json_fallback";
  }
  return "plain_json_text";
}

// ── reasoning 状态归一化 ──────────────────────────────────

/**
 * 把 reasoning 配置归一化为明确的 on/off，不返回 auto。
 * Profile 匹配需要明确的 reasoning 状态，不能传 auto。
 */
export function resolveActionGateReasoningState(
  reasoning: ReasoningPreference | undefined,
  capability: ReasoningCapability,
): "on" | "off" {
  const effective = resolveEffectiveReasoning(reasoning ?? { mode: "auto" }, capability);
  return effective.mode === "on" ? "on" : "off";
}

/** 便捷方法：从 provider+model 解析 reasoning capability + 归一化 reasoning 状态。 */
export function resolveActionGateReasoningFromSettings(
  providerId: string,
  model: string,
  reasoning: ReasoningPreference | undefined,
): "on" | "off" {
  const capability = resolveReasoningCapability(providerId, model);
  return resolveActionGateReasoningState(reasoning, capability);
}
