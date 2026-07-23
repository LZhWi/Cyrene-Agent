import type {
  StructuredOutputMode,
  StructuredOutputProfile,
  StructuredOutputProfileContext,
  StructuredOutputVerification,
} from "./types";

interface ProfileDefinition {
  id: string;
  provider: string;
  transport: StructuredOutputProfileContext["transport"];
  modelPattern: RegExp;
  mode: StructuredOutputMode;
  verification: StructuredOutputVerification;
  requestHints?: Partial<StructuredOutputProfile["requestHints"]>;
}

const DEFINITIONS: readonly ProfileDefinition[] = [
  {
    id: "openai-structured-output",
    provider: "chatgpt",
    transport: "openai",
    modelPattern: /^(?:gpt-5(?:\.\d+)?(?:-(?:sol|terra|luna))?|gpt-4\.1(?:$|-)|gpt-4o-mini(?:$|-)|gpt-4o-(?:2024-08-06|2024-11-20)|o[134](?:$|-))/i,
    mode: "provider_json_schema",
    verification: "official",
  },
  {
    id: "claude-structured-output",
    provider: "claude",
    transport: "anthropic",
    modelPattern: /^claude-(?:fable-5|mythos(?:-5|-preview)|opus-4-[5-8]|sonnet-(?:5|4-[56])|haiku-4-5)(?:$|-\d{8})/i,
    mode: "provider_json_schema",
    verification: "official",
  },
  {
    id: "kimi-structured-output",
    provider: "kimi",
    transport: "openai",
    modelPattern: /^kimi-(?:k3|k2\.(?:6|7-code(?:-highspeed)?))(?:$|-)/i,
    mode: "provider_json_schema",
    verification: "official",
  },
  {
    id: "doubao-structured-output",
    provider: "doubao",
    transport: "openai",
    modelPattern: /^doubao-seed-(?:1-6|1-8|2-[01])(?:$|-)/i,
    mode: "provider_json_schema",
    verification: "official",
  },
  {
    id: "deepseek-json-object",
    provider: "deepseek",
    transport: "openai",
    modelPattern: /^deepseek-v4-(?:pro|flash)$/i,
    mode: "provider_json_object",
    verification: "official",
  },
  {
    id: "qwen-json-object",
    provider: "qwen",
    transport: "openai",
    modelPattern: /^(?:qwen3\.(?:7|8)-(?:max|plus)|qwen-flash)(?:$|-)/i,
    mode: "provider_json_object",
    verification: "official",
  },
  {
    id: "glm-json-object",
    provider: "glm",
    transport: "openai",
    modelPattern: /^glm-(?:5\.2|4\.[67])(?:$|-)/i,
    mode: "provider_json_object",
    verification: "official",
  },
  {
    id: "mimo-json-object",
    provider: "mimo",
    transport: "openai",
    modelPattern: /^mimo-v2\.5(?:$|-)/i,
    mode: "provider_json_object",
    verification: "official",
  },
  {
    id: "minimax-m3-prompt-json",
    provider: "minimax",
    transport: "openai",
    modelPattern: /^MiniMax-M3(?:$|[-_])/i,
    mode: "prompt_json",
    verification: "contract_verified",
    requestHints: { sendJsonObject: true, reasoningSplit: true },
  },
];

const REPAIR: StructuredOutputProfile["repair"] = {
  cita: {
    maxAttempts: 2,
    totalBudgetMs: 8_000,
    perAttemptTimeoutMs: 4_000,
    minimumRemainingBudgetMs: 500,
  },
  action_gate: {
    maxAttempts: 2,
    totalBudgetMs: 10_000,
    perAttemptTimeoutMs: 5_000,
    minimumRemainingBudgetMs: 800,
  },
};

function materialize(
  definition: ProfileDefinition,
  context: StructuredOutputProfileContext,
): StructuredOutputProfile {
  return {
    id: definition.id,
    provider: definition.provider,
    model: context.model,
    transport: definition.transport,
    mode: definition.mode,
    verification: definition.verification,
    allowCapabilityPromotion: false,
    requestHints: {
      sendJsonObject: definition.requestHints?.sendJsonObject ?? false,
      reasoningSplit: definition.requestHints?.reasoningSplit ?? false,
    },
    reasoning: "disabled",
    repair: REPAIR,
  };
}

const FALLBACK: StructuredOutputProfile = {
  id: "prompt-json-fallback",
  provider: "unknown",
  model: "unknown",
  mode: "prompt_json",
  verification: "contract_required",
  allowCapabilityPromotion: false,
  requestHints: { sendJsonObject: false, reasoningSplit: false },
  reasoning: "disabled",
  repair: REPAIR,
};

export function resolveStructuredOutputProfile(
  context: StructuredOutputProfileContext,
): StructuredOutputProfile {
  const fallback: StructuredOutputProfile = {
    ...FALLBACK,
    provider: context.provider,
    model: context.model,
  };
  if (context.endpointKind !== "official") return fallback;
  const match = DEFINITIONS.find((definition) => (
    definition.provider === context.provider
    && definition.transport === context.transport
    && definition.modelPattern.test(context.model)
  ));
  return match ? materialize(match, context) : fallback;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

export function classifyStructuredOutputEndpoint(input: {
  providerId: string;
  configuredBaseUrl: string;
  officialBaseUrl: string;
}): StructuredOutputProfileContext["endpointKind"] {
  const configured = normalizeBaseUrl(input.configuredBaseUrl);
  if (/^https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?::|\/|$)/.test(configured)) {
    return "local";
  }
  if (
    input.providerId === "unknown"
    || !configured
    || !input.officialBaseUrl
    || configured !== normalizeBaseUrl(input.officialBaseUrl)
  ) {
    return "custom";
  }
  return "official";
}
