import type { PluginContext, PluginMemoryQueryRoute } from "@playa0v0/cyrene-plugin-sdk";

const SETTINGS_KEY = "memory-query-router-settings";
const SECRET_KEY = "memory-query-router-api-key";
const FALLBACK: PluginMemoryQueryRoute = { needsExpansion: false, retrievalKinds: [], scope: "normal", confidence: 0, source: "fallback" };
interface Settings {
  enabled: boolean;
  provider: string;
  baseUrl: string;
  model: string;
  explicitTransport: "auto" | "openai" | "anthropic";
  reasoning: "auto" | "off" | "low";
}
const DEFAULTS: Settings = { enabled: false, provider: "自定义", baseUrl: "", model: "", explicitTransport: "auto", reasoning: "off" };

function normalize(raw: any): Settings {
  const settings = {
    enabled: raw?.enabled === true,
    provider: typeof raw?.provider === "string" && raw.provider.trim() ? raw.provider.trim() : "自定义",
    baseUrl: typeof raw?.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/+$/, "") : "",
    model: typeof raw?.model === "string" ? raw.model.trim() : "",
    explicitTransport: (["openai", "anthropic"] as const).includes(raw?.explicitTransport) ? raw.explicitTransport : "auto",
    reasoning: (["low", "auto"] as const).includes(raw?.reasoning) ? raw.reasoning : "off",
  } as Settings;
  if ([settings.provider, settings.baseUrl, settings.model].some((value) => value.length > 2048)) throw new Error("查询路由设置无效");
  if (settings.enabled && (!settings.baseUrl || !settings.model)) throw new Error("启用查询路由前请填写地址和模型");
  return settings;
}

export function createQueryRouter(ctx: PluginContext) {
  let settings = normalize(ctx.storage.get<unknown>(SETTINGS_KEY) ?? DEFAULTS);
  const route = async (query: string, signal: AbortSignal): Promise<PluginMemoryQueryRoute> => {
    if (!settings.enabled || !query.trim()) return { ...FALLBACK };
    if (!ctx.deps.memoryRetrieval?.routeQuery || !ctx.deps.secrets) return { ...FALLBACK };
    const apiKey = await ctx.deps.secrets.get(SECRET_KEY);
    if (!apiKey) return { ...FALLBACK };
    return ctx.deps.memoryRetrieval.routeQuery({ query, ...settings, apiKey, signal });
  };
  return {
    async view() { return { ...settings, hasKey: Boolean(await ctx.deps.secrets?.get(SECRET_KEY)) }; },
    async save(raw: any) {
      const next = normalize(raw);
      if (typeof raw?.apiKey === "string" && raw.apiKey.trim()) {
        if (!ctx.deps.secrets) throw new Error("宿主密钥服务不可用");
        await ctx.deps.secrets.set(SECRET_KEY, raw.apiKey.trim());
      }
      if (next.enabled && !await ctx.deps.secrets?.get(SECRET_KEY)) throw new Error("启用查询路由前请保存 API Key");
      ctx.storage.set(SETTINGS_KEY, next); settings = next;
      return this.view();
    },
    async test(signal: AbortSignal) {
      if (!settings.enabled) throw new Error("请先启用查询路由");
      return route("我们说好的礼物还记得吗？", signal);
    },
    route,
  };
}
