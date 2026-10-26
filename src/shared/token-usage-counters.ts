export interface TokenUsageDay {
  input: number;
  output: number;
  /** 厂商明确上报的缓存读取 token。 */
  hit: number;
  /** 同一批已上报缓存明细的输入中，未命中缓存的 token。 */
  miss: number;
  /** 厂商明确上报的缓存创建 token（cache_creation_input_tokens）。 */
  cacheCreation: number;
  /** 返回了缓存明细的请求数；0 表示该日没有可用的缓存数据。 */
  cacheUsageRequests?: number;
  requests: number;
  /** 所有发出的模型请求数（含厂商未返回 usage 的）；用于统计覆盖率。 */
  attemptedRequests?: number;
  /** 从 v2 起按真实模型名聚合；旧数据不具备此维度。 */
  models?: Record<string, TokenUsageModel>;
}

export interface TokenUsageModel {
  input: number;
  output: number;
  hit: number;
  miss: number;
  /** 厂商明确上报的缓存创建 token（cache_creation_input_tokens）。 */
  cacheCreation: number;
  /** 厂商实际返回缓存统计的请求数；缺失代表历史数据或暂无可用数据。 */
  cacheUsageRequests?: number;
  requests: number;
  /** 所有发出的模型请求数（含厂商未返回 usage 的）；用于统计覆盖率。 */
  attemptedRequests?: number;
}

export function applyUsageToDay(
  day: TokenUsageDay,
  input: number,
  output: number,
  requests = 1,
  cachedInput?: number,
  model?: string,
  cacheCreation?: number,
): void {
  day.input += Math.max(0, Math.round(input || 0));
  day.output += Math.max(0, Math.round(output || 0));
  day.requests += Math.max(0, requests);
  if (typeof cachedInput === "number" && Number.isFinite(cachedInput)) {
    const normalizedInput = Math.max(0, Math.round(input || 0));
    const normalizedCachedInput = Math.max(0, Math.min(normalizedInput, Math.round(cachedInput)));
    day.hit += normalizedCachedInput;
    day.miss += normalizedInput - normalizedCachedInput;
    day.cacheUsageRequests = (day.cacheUsageRequests ?? 0) + Math.max(0, requests);
  }
  if (typeof cacheCreation === "number" && Number.isFinite(cacheCreation)) {
    day.cacheCreation = (day.cacheCreation ?? 0) + Math.max(0, Math.round(cacheCreation));
  }
  const modelName = model?.trim() || "未归类";
  const byModel = day.models ?? {};
  const modelDay = byModel[modelName] ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
  modelDay.input += Math.max(0, Math.round(input || 0));
  modelDay.output += Math.max(0, Math.round(output || 0));
  modelDay.requests += Math.max(0, requests);
  if (typeof cachedInput === "number" && Number.isFinite(cachedInput)) {
    const normalizedInput = Math.max(0, Math.round(input || 0));
    const normalizedCachedInput = Math.max(0, Math.min(normalizedInput, Math.round(cachedInput)));
    modelDay.hit += normalizedCachedInput;
    modelDay.miss += normalizedInput - normalizedCachedInput;
    modelDay.cacheUsageRequests = (modelDay.cacheUsageRequests ?? 0) + Math.max(0, requests);
  }
  if (typeof cacheCreation === "number" && Number.isFinite(cacheCreation)) {
    modelDay.cacheCreation = (modelDay.cacheCreation ?? 0) + Math.max(0, Math.round(cacheCreation));
  }
  byModel[modelName] = modelDay;
  day.models = byModel;
}

