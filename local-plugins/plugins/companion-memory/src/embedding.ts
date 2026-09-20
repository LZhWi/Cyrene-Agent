import type { PluginContext } from "@playa0v0/cyrene-plugin-sdk";

export interface EmbeddingConfig { enabled: boolean; baseUrl: string; model: string; dimensions: number }
export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = { enabled: false, baseUrl: "", model: "", dimensions: 1024 };

export function embeddingEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("Embedding 地址必须为 HTTPS，或本机 HTTP；不得含凭据、查询参数或片段");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/embeddings$/, "")}/embeddings`;
  return url.toString();
}

export function parseEmbeddingConfig(raw: any): EmbeddingConfig {
  if (!raw || typeof raw.enabled !== "boolean" || typeof raw.baseUrl !== "string" || raw.baseUrl.length > 2048 ||
    typeof raw.model !== "string" || raw.model.length > 2048 || !Number.isSafeInteger(raw.dimensions) || raw.dimensions < 64 || raw.dimensions > 8192) throw new Error("Embedding 配置无效");
  if (raw.enabled || raw.baseUrl.trim() || raw.model.trim()) {
    embeddingEndpoint(raw.baseUrl.trim());
    if (!raw.model.trim()) throw new Error("请输入 Embedding 模型名称");
  }
  return { enabled: raw.enabled, baseUrl: raw.baseUrl.trim(), model: raw.model.trim(), dimensions: raw.dimensions };
}

export function createEmbeddingService(ctx: PluginContext, fetcher: typeof fetch = fetch) {
  let config = parseEmbeddingConfig(ctx.storage.get<EmbeddingConfig>("embedding-config") ?? DEFAULT_EMBEDDING_CONFIG);
  async function embed(text: string, signal: AbortSignal): Promise<number[]> {
    const snapshot = { ...config };
    if (!snapshot.enabled) throw new Error("Embedding 尚未启用");
    if (!text.trim() || text.length > 20000) throw new Error("Embedding 输入无效");
    const key = await ctx.deps.secrets?.get("embedding-key") ?? "";
    const combined = AbortSignal.any([signal, ctx.signal, AbortSignal.timeout(120000)]);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (key) headers.Authorization = `Bearer ${key}`;
      const response = await fetcher(embeddingEndpoint(snapshot.baseUrl), {
        method: "POST", redirect: "error", signal: combined, headers,
        body: JSON.stringify({ model: snapshot.model, input: text }),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const value = (await response.json() as any)?.data?.[0]?.embedding;
      if (!Array.isArray(value) || value.length !== snapshot.dimensions || value.some((n) => !Number.isFinite(n))) throw new Error("维度或输出无效");
      return value;
    } catch { throw new Error(combined.aborted ? "Embedding 请求已取消或超时" : "Embedding 请求失败或维度不匹配，请检查地址、模型、维度及凭据"); }
  }
  return {
    get config() { return { ...config }; },
    async view() { return { ...config, hasKey: Boolean(await ctx.deps.secrets?.get("embedding-key")) }; },
    async save(raw: any) {
      const next = parseEmbeddingConfig(raw);
      if (raw.apiKey !== undefined && (typeof raw.apiKey !== "string" || raw.apiKey.length > 8192)) throw new Error("Embedding 密钥格式无效");
      const oldKey = await ctx.deps.secrets?.get("embedding-key");
      if (!raw.apiKey?.trim() && oldKey && config.baseUrl && embeddingEndpoint(config.baseUrl) !== embeddingEndpoint(next.baseUrl)) throw new Error("Embedding 地址已改变，请重新输入密钥；不会把旧密钥自动发送到新地址");
      if (raw.apiKey?.trim()) {
        if (!ctx.deps.secrets) throw new Error("宿主安全凭据存储不可用");
        await ctx.deps.secrets.set("embedding-key", raw.apiKey.trim());
      }
      ctx.storage.set("embedding-config", next); config = next;
      return this.view();
    },
    embed,
    async test(signal: AbortSignal) { const vector = await embed("Cyrene embedding connection test", signal); return { dimensions: vector.length }; },
  };
}
