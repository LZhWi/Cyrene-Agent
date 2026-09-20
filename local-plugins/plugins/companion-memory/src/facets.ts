export const MEMORY_KINDS = ["commitment", "preference", "goal", "wish", "experience", "fact", "emotion", "other"] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
export interface MemoryFacets { primaryKind: MemoryKind; retrievalKinds: MemoryKind[]; source: "model" | "pending" | "query_rule"; pendingClassification: boolean }
export type RetrievalScope = "normal" | "scoped_list" | "exhaustive_list";
export interface RetrievalPlan {
  scope: RetrievalScope;
  semanticResults: number;
  kindResults: number;
  maxResults: number;
  characterBudget: number;
  queryKind?: MemoryKind;
}
const kinds = new Set<string>(MEMORY_KINDS);

export function normalizeStoredFacets(input: unknown): MemoryFacets | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("记忆 facets 结构无效");
  const raw = input as Record<string, unknown>;
  if (typeof raw.primaryKind !== "string" || !kinds.has(raw.primaryKind) || !Array.isArray(raw.retrievalKinds) || raw.retrievalKinds.some((kind) => typeof kind !== "string" || !kinds.has(kind)) || raw.retrievalKinds.length < 1 || raw.retrievalKinds.length > 3 || !["model", "pending", "query_rule"].includes(String(raw.source)) || typeof raw.pendingClassification !== "boolean") throw new Error("记忆 facets 结构无效");
  const retrievalKinds = [...new Set(raw.retrievalKinds as MemoryKind[])];
  if (!retrievalKinds.includes(raw.primaryKind as MemoryKind)) retrievalKinds.unshift(raw.primaryKind as MemoryKind);
  return { primaryKind: raw.primaryKind as MemoryKind, retrievalKinds: retrievalKinds.slice(0, 3), source: raw.source as MemoryFacets["source"], pendingClassification: raw.pendingClassification };
}

/** 查询规则只做召回路由，不反向改写记忆分类。无法明确识别时不缩小候选。 */
export function inferQueryKind(text: string): MemoryKind | undefined {
  const value = text.normalize("NFC").trim();
  if (/约定|承诺|答应|说好|保证|拉钩/u.test(value)) return "commitment";
  if (/喜欢|偏好|爱好|习惯|不喜欢|讨厌/u.test(value)) return "preference";
  if (/目标|计划|打算|准备|想要.{0,12}(?:完成|做到|实现|学习)|希望.{0,12}(?:完成|做到|实现|学会)/u.test(value)) return "goal";
  if (/共同期待|一起期待|期待|愿望|盼望|憧憬|但愿|希望/u.test(value)) return "wish";
  if (/经历|曾经|以前|小时候|上次发生|做过|去过/u.test(value)) return "experience";
  if (/难过|开心|害怕|焦虑|生气|孤独|紧张|羞愧|愤怒|悲伤|兴奋/u.test(value)) return "emotion";
  if (/事实|个人信息|资料|叫什么|住在哪里|职业/u.test(value)) return "fact";
  return undefined;
}
export const isFacetListQuery = (text: string) => /哪些|所有|全部|列出|有什么|都(?:有|是|说过)|记得.{0,8}什么/u.test(text.normalize("NFC"));
export const isExhaustiveFacetListQuery = (text: string) => /每一个|每一条|所有|全部|完整列出|一个不漏/u.test(text.normalize("NFC"));
export const matchesFacet = (facets: MemoryFacets | undefined, kind: MemoryKind | undefined) => Boolean(kind && facets?.source === "model" && facets.retrievalKinds.includes(kind));

/** 与本地版 memory-facets 的数量和正文预算保持一致；规则无法可靠识别时只取原语义 Top 5。 */
export function resolveRetrievalPlan(query: string): RetrievalPlan {
  const queryKind = inferQueryKind(query);
  if (!queryKind || !isFacetListQuery(query)) {
    return { scope: "normal", semanticResults: 5, kindResults: 0, maxResults: 5, characterBudget: 1800 };
  }
  const scope: RetrievalScope = isExhaustiveFacetListQuery(query) ? "exhaustive_list" : "scoped_list";
  return {
    scope,
    semanticResults: 5,
    kindResults: scope === "exhaustive_list" ? 15 : 8,
    maxResults: scope === "exhaustive_list" ? 20 : 13,
    characterBudget: scope === "exhaustive_list" ? 4000 : 3000,
    queryKind,
  };
}
