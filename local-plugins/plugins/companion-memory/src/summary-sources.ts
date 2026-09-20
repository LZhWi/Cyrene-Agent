export interface SourceRange { start: number; end: number }
export interface SourceNode { id: string; isSummary?: boolean; subEntryIds?: string[] }
export type SummarySource = { status: "derived"; range: SourceRange } | { status: "missing-child" | "cycle" | "unresolved-child" | "empty-children" };

/** 只推导来源时间包络，不证明总结语义，也不把包络误作事实持续时间。 */
export function deriveSummarySources(nodes: SourceNode[], located: ReadonlyMap<string, SourceRange>): Map<string, SummarySource> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length || nodes.some((node) => typeof node.id !== "string" || !node.id)) throw new Error("记忆标识无效或重复");
  for (const range of located.values()) if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start > range.end) throw new Error("来源范围无效");
  const results = new Map<string, SummarySource>();
  function resolve(id: string, visiting: Set<string>): SummarySource {
    if (visiting.has(id)) return { status: "cycle" };
    const node = byId.get(id); if (!node) return { status: "missing-child" };
    if (!node.isSummary) { const range = located.get(id); return range ? { status: "derived", range: { ...range } } : { status: "unresolved-child" }; }
    if (results.has(id)) return results.get(id)!;
    if (!Array.isArray(node.subEntryIds) || !node.subEntryIds.length) return { status: "empty-children" };
    if (node.subEntryIds.some((child) => typeof child !== "string" || !child)) return { status: "missing-child" };
    const children = [...new Set(node.subEntryIds)].map((child) => resolve(child, new Set(visiting).add(id)));
    const failure = children.find((child) => child.status !== "derived");
    const result: SummarySource = failure ?? { status: "derived", range: { start: Math.min(...children.map((child) => child.status === "derived" ? child.range.start : Infinity)), end: Math.max(...children.map((child) => child.status === "derived" ? child.range.end : -Infinity)) } };
    results.set(id, result); return result;
  }
  for (const node of nodes.filter((item) => item.isSummary)) results.set(node.id, resolve(node.id, new Set()));
  return results;
}
