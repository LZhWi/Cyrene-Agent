import type { PluginMemoryQueryRoute, PluginMemoryRetrievalService } from "../../plugins/api";
import { getEmbeddingProvider, getEmbeddingProviderIdentity } from "../rag/embedding";
import { detachedBm25TopScore, rankDetachedMemoryCandidates } from "../rag/retriever";
import { createStandardReranker, getRerankerInstallStatus } from "../rag/reranker";
import { getAdapterForConfig, type VendorConfig } from "../orchestrator/vendors";
import { recordUsage } from "../token-usage-store";
import { pluginHostError } from "./errors";

const MAX_CANDIDATES = 20_000;
const QUERY_ROUTE_TIMEOUT_MS = 15_000;
const QUERY_ROUTE_KINDS = new Set(["commitment", "preference", "goal", "wish", "experience", "fact", "emotion"]);
const QUERY_ROUTE_FALLBACK: PluginMemoryQueryRoute = { needsExpansion: false, retrievalKinds: [], scope: "normal", confidence: 0, source: "fallback" };

function queryRoutePrompt(query: string): string {
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
    '{"needsExpansion":boolean,"retrievalKinds":[],"scope":"normal|scoped_list|exhaustive_list","confidence":0到1}',
    `用户消息：${query}`,
  ].join("\n");
}

function parseQueryRoute(text: string): PluginMemoryQueryRoute {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
    const start = fenced.indexOf("{"), end = fenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("missing JSON object");
    const value = JSON.parse(fenced.slice(start, end + 1)) as Record<string, unknown>;
    const scope = value.scope === "scoped_list" || value.scope === "exhaustive_list" ? value.scope : "normal";
    const retrievalKinds = Array.isArray(value.retrievalKinds)
      ? [...new Set(value.retrievalKinds.filter((kind): kind is PluginMemoryQueryRoute["retrievalKinds"][number] => typeof kind === "string" && QUERY_ROUTE_KINDS.has(kind)))].slice(0, 3)
      : [];
    const confidence = Math.max(0, Math.min(typeof value.confidence === "number" ? value.confidence : 0, 1));
    if (value.needsExpansion !== true || retrievalKinds.length === 0) return { needsExpansion: false, retrievalKinds: [], scope: "normal", confidence, source: "llm" };
    return { needsExpansion: true, retrievalKinds, scope, confidence, source: "llm" };
  } catch {
    return { ...QUERY_ROUTE_FALLBACK };
  }
}

export function createPluginMemoryRetrievalService(signal: AbortSignal): PluginMemoryRetrievalService {
  const activeSignal = (extra?: AbortSignal) => extra ? AbortSignal.any([signal, extra]) : signal;
  const ensureRunning = (extra?: AbortSignal) => {
    if (activeSignal(extra).aborted) throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，记忆检索服务不可用");
  };
  return {
    async embed(texts, options = {}) {
      ensureRunning(options.signal);
      if (!Array.isArray(texts) || texts.length < 1 || texts.length > 100 || texts.some((text) => typeof text !== "string" || !text.trim() || text.length > 20_000)) throw new Error("Embedding 输入无效");
      const provider = getEmbeddingProvider();
      if (!provider) throw new Error("宿主 BGE-M3 Provider 不可用");
      const vectors = await provider.embedBatch(texts);
      ensureRunning(options.signal);
      const identity = await getEmbeddingProviderIdentity();
      return { vectors, identity };
    },
    async rank(input) {
      ensureRunning(input.signal);
      if (!input.query?.trim() || input.query.length > 20_000 || !Number.isSafeInteger(input.topK) || input.topK < 1 || input.topK > 50 || !Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES || (input.mode !== undefined && !["hybrid", "semantic", "lexical"].includes(input.mode))) throw new Error("记忆检索请求无效");
      const ids = new Set<string>();
      for (const candidate of input.candidates) {
        if (!candidate?.id || ids.has(candidate.id) || !candidate.text?.trim() || candidate.text.length > 20_000 || !Array.isArray(candidate.embedding) || candidate.embedding.some((value) => !Number.isFinite(value)) || !Number.isFinite(candidate.weight) || candidate.weight < 0 || candidate.weight > 5 || !Number.isFinite(candidate.lastRecalledAt) || candidate.lastRecalledAt < 0) throw new Error("记忆检索候选无效");
        ids.add(candidate.id);
      }
      const result = await rankDetachedMemoryCandidates(input.query.trim(), input.candidates, input.topK, {
        mode: input.mode,
        rawScore: input.rawScore,
        ...(input.rerank === false ? { reranker: null } : {}),
      });
      ensureRunning(input.signal);
      return result;
    },
    async bm25TopScore(input) {
      ensureRunning(input.signal);
      if (!input.query?.trim() || !Array.isArray(input.documents) || input.documents.length > MAX_CANDIDATES
        || input.documents.some((text) => typeof text !== "string" || text.length > 20_000)) throw new Error("历史 BM25 预检请求无效");
      const score = detachedBm25TopScore(input.query, input.documents);
      ensureRunning(input.signal);
      return score;
    },
    async rerankDocuments(input) {
      ensureRunning(input.signal);
      if (!input.query?.trim() || !Array.isArray(input.documents) || input.documents.length > 96
        || input.documents.some((text) => typeof text !== "string" || !text.trim() || text.length > 20_000)) throw new Error("历史重排请求无效");
      if (!getRerankerInstallStatus().standard) return null;
      const reranker = await createStandardReranker();
      const ranked = await reranker.rerank(input.query, input.documents);
      ensureRunning(input.signal);
      return ranked;
    },
    async routeQuery(input) {
      ensureRunning(input.signal);
      if (!input.query?.trim() || input.query.length > 20_000 || !input.baseUrl?.trim() || !input.apiKey?.trim() || !input.model?.trim()
        || !["auto", "openai", "anthropic"].includes(input.explicitTransport) || !["auto", "off", "low"].includes(input.reasoning)) throw new Error("记忆查询路由请求无效");
      const config: VendorConfig = {
        provider: input.provider?.trim() || "自定义",
        baseUrl: input.baseUrl.trim(),
        apiKey: input.apiKey.trim(),
        model: input.model.trim(),
        explicitTransport: input.explicitTransport,
        reasoning: input.reasoning === "low" ? { mode: "on", effort: "low" } : input.reasoning === "auto" ? { mode: "auto" } : { mode: "off" },
      };
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), QUERY_ROUTE_TIMEOUT_MS);
        const requestSignal = input.signal ? AbortSignal.any([activeSignal(input.signal), controller.signal]) : AbortSignal.any([signal, controller.signal]);
        try {
          const adapter = getAdapterForConfig(config);
          const http = adapter.buildRequest({ model: config.model, messages: [{ role: "user", content: queryRoutePrompt(input.query.trim()) }], maxTokens: 256, stream: false, extraBody: { response_format: { type: "json_object" } } }, config);
          const response = await fetch(http.url, { method: "POST", headers: http.headers, body: http.body, signal: requestSignal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const parsed = adapter.parseResponse(await response.json());
          if (parsed.usage) recordUsage(parsed.usage.input, parsed.usage.output, 1, parsed.usage.cachedInput);
          const route = parseQueryRoute(parsed.text.trim() || parsed.thinking?.trim() || "");
          if (route.source === "fallback") throw new Error("invalid router response");
          ensureRunning(input.signal);
          return route;
        } catch (error) {
          lastError = error;
          if (requestSignal.aborted && activeSignal(input.signal).aborted) throw pluginHostError("E_PLUGIN_STOPPING", "插件已停止，记忆查询路由不可用");
        } finally {
          clearTimeout(timer);
        }
      }
      console.warn("[MemoryQueryRouter] route failed twice; using semantic Top 5:", lastError);
      return { ...QUERY_ROUTE_FALLBACK };
    },
  };
}
