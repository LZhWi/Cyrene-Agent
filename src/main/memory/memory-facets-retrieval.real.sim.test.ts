// 真实 L2 向量只读 A/B：固定语义 Top5 vs 语义 Top5 + kind 通道。历史不参与分类。
import * as fs from "fs";
import { describe, expect, it } from "vitest";
import { deriveLocalMemoryFacets, repairStoredMemoryFacets, resolveRetrievalPlan, selectFacetAwareItems, type MemoryFacets, type MemoryKind } from "./memory-facets";

const USER_DATA = process.env.CYRENE_MEMORY_EVAL_DATA_DIR ?? "C:/Users/ASUS/AppData/Roaming/live2d-cyrene";
const MEMORY_PATH = `${USER_DATA}/memory.json`;
const RAG_PATH = `${USER_DATA}/rag-data/memory-store.json`;
const DATA_EXISTS = fs.existsSync(MEMORY_PATH) && fs.existsSync(RAG_PATH);

interface Item {
  id: string;
  text: string;
  embedding: number[];
  facets: MemoryFacets;
}

function evaluationFacets(stored: unknown, text: string): MemoryFacets {
  const model = repairStoredMemoryFacets(stored, text);
  if (model.source === "model") return model;
  const provisional = deriveLocalMemoryFacets(text);
  return { primaryKind: provisional.primaryKind, retrievalKinds: provisional.retrievalKinds, source: "model", pendingClassification: false };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    dot += a[index] * b[index];
    aa += a[index] * a[index];
    bb += b[index] * b[index];
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0;
}

function queryFor(kind: MemoryKind): string {
  if (kind === "commitment") return "列出所有约定";
  if (kind === "preference") return "列出所有喜欢和偏好";
  if (kind === "goal") return "列出所有目标和计划";
  if (kind === "wish") return "列出所有期待和愿望";
  if (kind === "experience") return "列出所有以前经历过的事情";
  if (kind === "emotion") return "列出所有难过开心的情绪记忆";
  return "列出所有相关事实";
}

describe.skipIf(!DATA_EXISTS)("真实数据双通道检索 A/B（只读）", () => {
  it("preserves semantic Top5 and improves or retains labelled coverage", () => {
    const memory = JSON.parse(fs.readFileSync(MEMORY_PATH, "utf8")) as {
      l2?: Array<{ id: string; content: string; triggerText?: string; status?: string; facets?: unknown }>;
    };
    const l2ById = new Map((memory.l2 ?? []).map((entry) => [entry.id, entry]));
    const raw = JSON.parse(fs.readFileSync(RAG_PATH, "utf8")) as Array<{
      id: string; text: string; source: string; embedding: number[]; metadata?: Record<string, unknown>;
    }>;
    const sources: Record<string, Item[]> = { user_memory: [] };
    for (const entry of raw) {
      if (entry.source === "user_memory") {
        const l2Id = typeof entry.metadata?.l2Id === "string" ? entry.metadata.l2Id : "";
        const l2 = l2ById.get(l2Id);
        if (!l2 || (l2.status !== "active" && l2.status !== "aging")) continue;
        sources.user_memory.push({
          id: entry.id, text: entry.text, embedding: entry.embedding,
          facets: evaluationFacets(l2.facets, `${l2.content} ${l2.triggerText ?? ""}`),
        });
      }
    }

    let cases = 0;
    let improvedCases = 0;
    const report: Record<string, unknown> = {};
    for (const [source, items] of Object.entries(sources)) {
      const sourceRows: Array<Record<string, unknown>> = [];
      for (const kind of ["commitment", "preference", "goal", "wish", "experience", "emotion"] as MemoryKind[]) {
        const group = items.filter((item) => item.facets.retrievalKinds.includes(kind));
        if (group.length < 2) continue;
        const seed = group[0];
        const ranked = items
          .filter((item) => item.id !== seed.id)
          .map((item) => ({ ...item, score: cosine(seed.embedding, item.embedding) }))
          .sort((a, b) => b.score - a.score);
        const baseline = ranked.slice(0, 5);
        const dual = selectFacetAwareItems(ranked, resolveRetrievalPlan(queryFor(kind), {
          needsExpansion: true,
          retrievalKinds: [kind],
          scope: "normal",
        }), {
          getText: (item) => item.text,
          getFacets: (item) => item.facets,
          getKey: (item) => item.id,
        });
        expect(dual.slice(0, 5).map((item) => item.id)).toEqual(baseline.map((item) => item.id));
        expect(new Set(dual.map((item) => item.id)).size).toBe(dual.length);
        const baselineCoverage = baseline.filter((item) => item.facets.retrievalKinds.includes(kind)).length;
        const dualCoverage = dual.filter((item) => item.facets.retrievalKinds.includes(kind)).length;
        expect(dualCoverage).toBeGreaterThanOrEqual(baselineCoverage);
        if (dualCoverage > baselineCoverage) improvedCases += 1;
        cases += 1;
        sourceRows.push({ kind, labelled: group.length, baselineCoverage, dualCoverage, returned: dual.length });
      }
      report[source] = sourceRows;
    }
    const allItems = Object.values(sources).flat();
    const storedModelSamples = (memory.l2 ?? []).filter((item) => (item.facets as { source?: unknown } | undefined)?.source === "model").length;
    console.log("[FacetRetrievalRealAB]", JSON.stringify({ cases, improvedCases, storedModelSamples, provisionalRuleSamples: allItems.length - storedModelSamples, report }));
    expect(cases).toBeGreaterThan(0);
    expect(improvedCases).toBeGreaterThan(0);
  });
});
