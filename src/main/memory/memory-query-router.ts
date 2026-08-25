import { getAdapterForConfig, type VendorConfig } from "../orchestrator/vendors";
import { recordUsage } from "../token-usage-store";
import type { MemoryKind, RetrievalScope } from "./memory-facets";

export interface MemoryQueryRouterSettings {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  explicitTransport: "auto" | "openai" | "anthropic";
  reasoning: "auto" | "off" | "low";
}

export interface MemoryQueryRoute {
  needsExpansion: boolean;
  retrievalKinds: MemoryKind[];
  scope: RetrievalScope;
  confidence: number;
  source: "llm" | "fallback";
}

interface RouteDependencies {
  request?: (prompt: string, settings: MemoryQueryRouterSettings, timeoutMs: number) => Promise<string>;
  timeoutMs?: number;
  onRawResponse?: (text: string) => void;
}

export const MEMORY_QUERY_ROUTER_TIMEOUT_MS = 15_000;

const ALLOWED_KINDS = new Set<MemoryKind>([
  "commitment", "preference", "goal", "wish", "experience", "fact", "emotion", "other",
]);
const FALLBACK_ROUTE: MemoryQueryRoute = {
  needsExpansion: false,
  retrievalKinds: [],
  scope: "normal",
  confidence: 0,
  source: "fallback",
};

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("missing JSON object");
  return JSON.parse(fenced.slice(start, end + 1));
}

export function parseMemoryQueryRoute(text: string): MemoryQueryRoute {
  try {
    const value = extractJson(text) as Record<string, unknown>;
    const scope = value.scope === "scoped_list" || value.scope === "exhaustive_list" ? value.scope : "normal";
    const kinds = Array.isArray(value.retrievalKinds)
      ? [...new Set(value.retrievalKinds.filter((kind): kind is MemoryKind => (
        typeof kind === "string" && ALLOWED_KINDS.has(kind as MemoryKind) && kind !== "other"
      )))].slice(0, 3)
      : [];
    const needsExpansion = value.needsExpansion === true && kinds.length > 0;
    const rawConfidence = typeof value.confidence === "number" ? value.confidence : 0;
    if (!needsExpansion) {
      return {
        needsExpansion: false,
        retrievalKinds: [],
        scope: "normal",
        confidence: Math.max(0, Math.min(rawConfidence, 1)),
        source: "llm",
      };
    }
    return {
      needsExpansion: true,
      retrievalKinds: kinds,
      scope,
      confidence: Math.max(0, Math.min(rawConfidence, 1)),
      source: "llm",
    };
  } catch {
    return { ...FALLBACK_ROUTE };
  }
}

function buildPrompt(query: string): string {
  return [
    "你是长期记忆检索的查询路由器，不是对用户这句话本身做关键词分类。只输出一个 JSON 对象，不写解释。",
    "判断当前消息是否需要在基础语义 Top 5 之外，按既有记忆类型补充召回过去相关记忆。",
    "允许的 retrievalKinds 仅为 commitment, preference, goal, wish, experience, fact, emotion；最多 3 个。",
    "commitment=明确承诺或双方说定；preference=喜好习惯；goal=计划目标；wish=愿望期待；experience=过去经历；fact=稳定事实；emotion=明确情绪。",
    "scope: normal=只指向某一个或极少数明确旧信息；scoped_list=当前自然表达代指同一主题下较完整的一组旧记忆；exhaustive_list=出现“每一个/所有/全部”等集合语义，或语境实际需要尽量完整覆盖该主题，遗漏会破坏回应。",
    "只要确认需要扩展，优先在 scoped_list 与 exhaustive_list 中选择；不要因为用户没有生硬地要求“列出”就降为 normal。不要求用户使用问句：日常陈述、接话、期待和感叹也可能自然代指一组旧记忆。",
    "不要因为表面词误判。例如“我问其他人这个电影怎么样，他们都说好看”不是 commitment，应 needsExpansion=false；“我们说好的礼物”是在指向既有约定，应包含 commitment，并通常为 scoped_list。",
    "例如“和你的每一个约定我都会记在本子上，而且以后能看着我做礼物”虽然是陈述句，但“每一个约定”代指完整约定集合，应 needsExpansion=true、retrievalKinds 包含 commitment、scope=exhaustive_list。",
    "若只是普通聊天、没有指向过去信息，或无法可靠判断，返回 needsExpansion=false。",
    '格式：{"needsExpansion":boolean,"retrievalKinds":[],"scope":"normal|scoped_list|exhaustive_list","confidence":0到1}',
    `用户消息：${query}`,
  ].join("\n");
}

function toVendorConfig(settings: MemoryQueryRouterSettings): VendorConfig {
  return {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    explicitTransport: settings.explicitTransport,
    reasoning: settings.reasoning === "low"
      ? { mode: "on", effort: "low" }
      : settings.reasoning === "auto" ? { mode: "auto" } : { mode: "off" },
  };
}

async function requestRoute(prompt: string, settings: MemoryQueryRouterSettings, timeoutMs: number): Promise<string> {
  const config = toVendorConfig(settings);
  const adapter = getAdapterForConfig(config);
  const http = adapter.buildRequest({
    model: settings.model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 256,
    stream: false,
    extraBody: { response_format: { type: "json_object" } },
  }, config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(http.url, {
      method: "POST",
      headers: http.headers,
      body: http.body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = adapter.parseResponse(await response.json());
    if (parsed.usage) recordUsage(parsed.usage.input, parsed.usage.output, 1, parsed.usage.cachedInput);
    return parsed.text.trim() || parsed.thinking?.trim() || "";
  } finally {
    clearTimeout(timer);
  }
}

export async function routeMemoryQuery(
  query: string,
  settings: MemoryQueryRouterSettings,
  dependencies: RouteDependencies = {},
): Promise<MemoryQueryRoute> {
  if (!settings.enabled || !settings.baseUrl || !settings.apiKey || !settings.model || !query.trim()) {
    return { ...FALLBACK_ROUTE };
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await (dependencies.request ?? requestRoute)(
        buildPrompt(query),
        settings,
        dependencies.timeoutMs ?? MEMORY_QUERY_ROUTER_TIMEOUT_MS,
      );
      dependencies.onRawResponse?.(response);
      const route = parseMemoryQueryRoute(response);
      if (route.source === "fallback") throw new Error("invalid router response");
      return route;
    } catch (error) {
      lastError = error;
    }
  }
  console.warn("[MemoryQueryRouter] route failed twice; using semantic Top 5:", lastError);
  return { ...FALLBACK_ROUTE };
}
