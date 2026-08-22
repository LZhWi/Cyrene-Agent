export type MemoryKind = "commitment" | "preference" | "goal" | "wish" | "experience" | "fact" | "emotion" | "other";
export type MemoryFacetSource = "model" | "pending" | "query_rule";

export interface MemoryFacets {
  primaryKind: MemoryKind;
  retrievalKinds: MemoryKind[];
  source: MemoryFacetSource;
  pendingClassification: boolean;
}

export type RetrievalScope = "normal" | "scoped_list" | "exhaustive_list";

export interface RetrievalPlan {
  scope: RetrievalScope;
  semanticResults: number;
  kindResults: number;
  maxResults: number;
  candidateDepth: number;
  characterBudget: number;
  queryKinds: MemoryKind[];
  queryKind?: MemoryKind;
}

export interface QueryRouteDecision {
  needsExpansion: boolean;
  retrievalKinds: MemoryKind[];
  scope: RetrievalScope;
  confidence?: number;
}

export type DynamicSelectionStopReason = "two_weak" | "character_budget" | "max_results" | "exhausted";

export interface DynamicSelectionResult<T> {
  selected: T[];
  examined: number;
  stoppedBy: DynamicSelectionStopReason;
}

/** 保留导出名兼容评估脚本；kind 通道现在是过滤后按既有语义顺序追加，不再做开放标签加权。 */
export const DEFAULT_FACET_RRF_WEIGHT = 0;
export const QUERY_ROUTE_MIN_CONFIDENCE = 0.5;
export const QUERY_ROUTE_FULL_SCOPE_CONFIDENCE = 0.75;

const MEMORY_KINDS = new Set<MemoryKind>([
  "commitment", "preference", "goal", "wish", "experience", "fact", "emotion", "other",
]);

/**
 * 本地只识别查询路由，不给生产记忆下分类结论。规则宁可返回 undefined，
 * 让不明确的查询只走原语义 Top5，也不错误缩小 kind 通道。
 */
export function inferQueryKindByRules(text: string): MemoryKind | undefined {
  const normalized = text.normalize("NFC").trim();
  if (/约定|承诺|答应|说好|保证|拉钩/u.test(normalized)) return "commitment";
  if (/喜欢|偏好|爱好|习惯|不喜欢|讨厌/u.test(normalized)) return "preference";
  if (/目标|计划|打算|准备|想要.{0,12}(?:完成|做到|实现|学习)|希望.{0,12}(?:完成|做到|实现|学会)/u.test(normalized)) return "goal";
  if (/共同期待|一起期待|期待|愿望|盼望|憧憬|但愿|希望/u.test(normalized)) return "wish";
  if (/经历|曾经|以前|小时候|上次发生|做过|去过/u.test(normalized)) return "experience";
  if (/难过|开心|害怕|焦虑|生气|孤独|紧张|羞愧|愤怒|悲伤|兴奋/u.test(normalized)) return "emotion";
  if (/事实|个人信息|资料|叫什么|住在哪里|职业/u.test(normalized)) return "fact";
  return undefined;
}

export function deriveLocalMemoryFacets(text: string): MemoryFacets {
  const kind = inferQueryKindByRules(text);
  return {
    primaryKind: kind ?? "other",
    retrievalKinds: [kind ?? "other"],
    source: "query_rule",
    pendingClassification: kind === undefined,
  };
}

export function createPendingMemoryFacets(): MemoryFacets {
  return { primaryKind: "other", retrievalKinds: ["other"], source: "pending", pendingClassification: true };
}

export function tryNormalizeModelFacets(input: unknown): MemoryFacets | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const primaryKind = typeof record.primaryKind === "string" && MEMORY_KINDS.has(record.primaryKind as MemoryKind)
    ? record.primaryKind as MemoryKind
    : typeof record.kind === "string" && MEMORY_KINDS.has(record.kind as MemoryKind)
      ? record.kind as MemoryKind
    : undefined;
  if (!primaryKind) return null;
  const rawRetrievalKinds = Array.isArray(record.retrievalKinds) ? record.retrievalKinds : [primaryKind];
  const valid = rawRetrievalKinds.filter((kind): kind is MemoryKind => (
    typeof kind === "string" && MEMORY_KINDS.has(kind as MemoryKind)
  ));
  let meaningful = [...new Set(valid.filter((kind) => kind !== "other"))];
  const normalizedPrimary = primaryKind === "other" && meaningful.length > 0 ? meaningful[0] : primaryKind;
  if (normalizedPrimary !== "other") meaningful = [normalizedPrimary, ...meaningful.filter((kind) => kind !== normalizedPrimary)];
  const retrievalKinds: MemoryKind[] = normalizedPrimary === "other" ? ["other"] : meaningful.slice(0, 3);
  if (retrievalKinds.length === 0) retrievalKinds.push(normalizedPrimary);
  return { primaryKind: normalizedPrimary, retrievalKinds, source: "model", pendingClassification: false };
}

export function normalizeMemoryFacets(input: unknown, fallbackText: string): MemoryFacets {
  void fallbackText;
  return tryNormalizeModelFacets(input) ?? createPendingMemoryFacets();
}

export function repairStoredMemoryFacets(input: unknown, fallbackText: string): MemoryFacets {
  void fallbackText;
  if (!input || typeof input !== "object" || (input as Record<string, unknown>).source !== "model") {
    return createPendingMemoryFacets();
  }
  return tryNormalizeModelFacets(input) ?? createPendingMemoryFacets();
}

export function resolveRetrievalPlan(query: string, route?: QueryRouteDecision): RetrievalPlan {
  void query;
  const confidence = typeof route?.confidence === "number" && Number.isFinite(route.confidence)
    ? Math.max(0, Math.min(route.confidence, 1))
    : 1;
  const queryKinds = route?.needsExpansion === true && confidence >= QUERY_ROUTE_MIN_CONFIDENCE
    ? [...new Set(route.retrievalKinds.filter((kind) => kind !== "other"))].slice(0, 3)
    : [];
  if (queryKinds.length === 0) {
    return {
      scope: "normal",
      semanticResults: 5,
      kindResults: 0,
      maxResults: 5,
      candidateDepth: 20,
      characterBudget: 1800,
      queryKinds: [],
    };
  }
  const scope = confidence >= QUERY_ROUTE_FULL_SCOPE_CONFIDENCE ? route?.scope ?? "normal" : "normal";
  return {
    scope,
    semanticResults: 5,
    kindResults: scope === "exhaustive_list" ? 15 : scope === "scoped_list" ? 8 : 5,
    maxResults: scope === "exhaustive_list" ? 20 : scope === "scoped_list" ? 13 : 10,
    candidateDepth: scope === "normal" ? 20 : 48,
    characterBudget: scope === "normal" ? 1800 : scope === "scoped_list" ? 3000 : 4000,
    queryKinds,
    queryKind: queryKinds[0],
  };
}

export function facetMatchScore(query: MemoryFacets, item: MemoryFacets | undefined): number {
  return query.primaryKind !== "other" && item?.source === "model" && item.retrievalKinds.includes(query.primaryKind) ? 1 : 0;
}

export const FACET_SUPPLEMENT_DEFAULT_MIN_SCORE = -4;
export const FACET_SUPPLEMENT_HARD_MIN_SCORE = -5;
export const FACET_SUPPLEMENT_MAX_SCORE_GAP = 2;

export function resolveFacetSupplementMinimumScore<T>(
  ranked: T[],
  plan: RetrievalPlan,
  options: {
    getFacets: (item: T) => MemoryFacets | undefined;
    getFacetScore?: (item: T) => number;
  },
): number | null {
  if (plan.scope === "exhaustive_list" || plan.queryKinds.length === 0 || !options.getFacetScore) return null;
  const sameKindAnchorScores = ranked.slice(0, plan.semanticResults).flatMap((item) => {
    const facets = options.getFacets(item);
    return facets?.source === "model" && plan.queryKinds.some((kind) => facets.retrievalKinds.includes(kind))
      ? [options.getFacetScore!(item)]
      : [];
  });
  if (sameKindAnchorScores.length === 0) return FACET_SUPPLEMENT_DEFAULT_MIN_SCORE;
  return Math.max(
    FACET_SUPPLEMENT_HARD_MIN_SCORE,
    Math.max(...sameKindAnchorScores) - FACET_SUPPLEMENT_MAX_SCORE_GAP,
  );
}

export function selectFacetAwareItems<T>(
  ranked: T[],
  plan: RetrievalPlan,
  options: {
    getText: (item: T) => string;
    getFacets: (item: T) => MemoryFacets | undefined;
    getKey?: (item: T) => string;
    getFacetScore?: (item: T) => number;
    facetWeight?: number;
  },
): T[] {
  void options.facetWeight;
  const semantic = ranked.slice(0, plan.semanticResults);
  if (plan.queryKinds.length === 0) return semantic;
  const keyOf = options.getKey ?? ((item: T) => options.getText(item).normalize("NFC").trim());
  const facetMinimumScore = resolveFacetSupplementMinimumScore(ranked, plan, options);
  const selected = [...semantic];
  const seen = new Set(selected.map(keyOf));
  let usedCharacters = selected.reduce((sum, item) => sum + options.getText(item).length, 0);
  let kindAdded = 0;
  for (const item of ranked) {
    const facets = options.getFacets(item);
    if (facets?.source !== "model" || !plan.queryKinds.some((kind) => facets.retrievalKinds.includes(kind))) continue;
    const key = keyOf(item);
    if (seen.has(key)) continue;
    if (
      facetMinimumScore !== null
      && options.getFacetScore
      && options.getFacetScore(item) < facetMinimumScore
    ) continue;
    const length = options.getText(item).length;
    if (usedCharacters + length > plan.characterBudget) break;
    selected.push(item);
    seen.add(key);
    usedCharacters += length;
    kindAdded += 1;
    if (kindAdded >= plan.kindResults || selected.length >= plan.maxResults) break;
  }
  return selected;
}

/**
 * 动态 L2 注入的纯选择策略。候选召回和强相关判定由调用方负责；这里仅保证：
 * 原语义 Top5 不变、单个弱项不会过早截断、连续两个弱项才停止，并限制最终上下文体积。
 */
export function selectDynamicMemoryItems<T>(
  ranked: T[],
  options: {
    getText: (item: T) => string;
    getKey: (item: T) => string;
    isStrong: (item: T) => boolean;
    semanticResults?: number;
    maxResults?: number;
    characterBudget?: number;
    weakStreakLimit?: number;
  },
): DynamicSelectionResult<T> {
  const semanticResults = options.semanticResults ?? 5;
  const maxResults = options.maxResults ?? 20;
  const characterBudget = options.characterBudget ?? 6000;
  const weakStreakLimit = options.weakStreakLimit ?? 2;
  const selected = ranked.slice(0, semanticResults);
  const seen = new Set(selected.map(options.getKey));
  let usedCharacters = selected.reduce((sum, item) => sum + options.getText(item).length, 0);
  let weakStreak = 0;
  let examined = selected.length;

  for (const item of ranked.slice(semanticResults)) {
    examined += 1;
    const key = options.getKey(item);
    if (seen.has(key)) continue;
    if (!options.isStrong(item)) {
      weakStreak += 1;
      if (weakStreak >= weakStreakLimit) return { selected, examined, stoppedBy: "two_weak" };
      continue;
    }
    weakStreak = 0;
    const length = options.getText(item).length;
    if (usedCharacters + length > characterBudget) {
      return { selected, examined, stoppedBy: "character_budget" };
    }
    selected.push(item);
    seen.add(key);
    usedCharacters += length;
    if (selected.length >= maxResults) return { selected, examined, stoppedBy: "max_results" };
  }
  return { selected, examined, stoppedBy: "exhausted" };
}
