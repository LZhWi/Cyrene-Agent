import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { createDmae } from "../plugins/companion-memory/src/dmae";
import { rankLocalMemoryCandidates } from "../plugins/companion-memory/src/retrieval";
import { resolveRetrievalPlan } from "../plugins/companion-memory/src/facets";

it.skipIf(!process.env.MEMORY_AB_DIR || !process.env.LOCAL_PROJECT_DIR)("隔离真实记忆 A/B 和 DMAE 只读预览", async () => {
  const base = process.env.MEMORY_AB_DIR!;
  const localRoot = process.env.LOCAL_PROJECT_DIR!;
  const nRoot = path.resolve(__dirname, "../..");
  process.env.CYRENE_MODELS_DIR = path.join(nRoot, "models");
  const read = (name: string) => JSON.parse(readFileSync(path.join(base, name), "utf8"));
  const sourceFiles = ["local-memory.json", "rag-data/memory-store.json", "n-memory-state.json", "n-vector-index.json", "n-dmae-state.json"];
  const hashes = sourceFiles.map((name) => createHash("sha256").update(readFileSync(path.join(base, name))).digest("hex"));
  const localRequire = createRequire(path.join(localRoot, "package.json"));
  const localPaths = localRequire("./dist/main/main/runtime/runtime-paths.js");
  localPaths.setAppPathProvider({ getPath: () => base, getAppPath: () => localRoot });
  const localRag = localRequire("./dist/main/main/rag/index.js");
  await localRag.initRAG("local", undefined, undefined, "bgem3");
  if (localRag.getRAGStats().sources.user_memory < 100) throw new Error("本地测试 RAG 未正确加载");
  localRequire("./dist/main/main/rag/reranker.js").configureRerankerForLazyInit("standard");
  const localDmae = localRequire("./dist/main/main/memory/dmae-manager.js").l2DmaeManager;
  const localL2 = read("local-memory.json").l2;
  const nState = read("n-memory-state.json");
  const nVector = read("n-vector-index.json");
  const storageData = new Map<string, unknown>([["memory-state", nState], ["dmae-state", read("n-dmae-state.json")], ["dmae-enabled", true]]);
  const storage: PluginStorage = { get: <T>(key: string) => structuredClone(storageData.get(key)) as T | undefined, set: (key: string, value: unknown) => { storageData.set(key, structuredClone(value)); }, rootDir: () => base };
  const memory = createMemory(storage), dmae = createDmae(storage);
  const nRequire = createRequire(path.join(nRoot, "package.json"));
  const nEmbedding = nRequire("./dist/main/main/rag/embedding.js");
  const nRetriever = nRequire("./dist/main/main/rag/retriever.js");
  const nReranker = await nRequire("./dist/main/main/rag/reranker.js").createStandardReranker();
  const provider = nEmbedding.getEmbeddingProvider("local", undefined, undefined, "bgem3");
  const service = {
    rank: ({ query, candidates, topK, mode, rawScore }: any) => nRetriever.rankDetachedMemoryCandidates(query, candidates, topK, { provider, reranker: null, mode, rawScore }),
    rerankDocuments: ({ query, documents }: any) => nReranker.rerank(query, documents),
  };
  const textById = new Map(memory.retrievalCandidates().map((row) => [row.id, row.text]));
  const candidates = nVector.entries.flatMap((row: any) => {
    const text = textById.get(row.l2Id);
    return text ? [{ id: row.l2Id, text, embedding: row.embedding, weight: row.weight ?? 1, lastRecalledAt: row.lastRecalledAt ?? nVector.importedAt }] : [];
  });
  const nIds = new Set(nState.entries.map((entry: any) => entry.id));
  const queries = localL2.filter((entry: any) => ["active", "aging"].includes(entry.status) && entry.syncStatus === "synced" && entry.ragId && entry.triggerText?.trim() && nIds.has(entry.id));
  const sampled = Array.from({ length: 20 }, (_, index) => queries[Math.floor(index * queries.length / 20)]);
  const metrics = { count: 0, topOneEqual: 0, exactTopFive: 0, overlappingTopFive: 0, nTopups: 0, localTopups: 0, sameFinalSet: 0, nTopupLowerThanBase: 0, nTopupCompared: 0, differences: [] as Array<{ queryIndex: number; local: string[]; n: string[] }> };
  const bases: string[][] = [];
  for (const [index, sample] of sampled.entries()) {
    const query = sample.triggerText;
    const local = await localRag.searchMemoryEntries(query, "user_memory", 5, { recordRecall: false, facetFusion: true });
    const localIds = local.map((row: any) => row.metadata?.l2Id).filter(Boolean);
    const ordered = await rankLocalMemoryCandidates(service, query, candidates, 20, [], new AbortController().signal);
    const nBase = memory.injectionCandidateIds(query, [], ordered.ids, [], resolveRetrievalPlan(query), ordered.scores);
    bases.push(nBase);
    const nFinal = dmae.preview(nBase, nState.entries).selectedIds;
    const localFinal = await localDmae.previewTurn(local, localL2);
    const localFinalIds = localFinal.map((row: any) => row.metadata?.l2Id).filter(Boolean);
    metrics.count++;
    metrics.topOneEqual += Number(localIds[0] === nBase[0]);
    metrics.exactTopFive += Number(JSON.stringify(localIds) === JSON.stringify(nBase));
    metrics.overlappingTopFive += nBase.filter((id: string) => localIds.includes(id)).length;
    metrics.nTopups += nFinal.filter((id: string) => !nBase.includes(id)).length;
    metrics.localTopups += localFinalIds.filter((id: string) => !localIds.includes(id)).length;
    metrics.sameFinalSet += Number(JSON.stringify(nFinal) === JSON.stringify(localFinalIds));
    if (JSON.stringify(localIds) !== JSON.stringify(nBase)) metrics.differences.push({ queryIndex: index, local: localIds, n: nBase });
    const topups = nFinal.filter((id: string) => !nBase.includes(id));
    if (topups.length && nBase.length) {
      const scored = await nReranker.rerank(query, [...nBase, ...topups].map((id: string) => textById.get(id) ?? ""));
      const byText = new Map(scored.map((row: any) => [row.text, row.score]));
      const weakestBase = Math.min(...nBase.map((id: string) => Number(byText.get(textById.get(id)))));
      for (const id of topups) {
        metrics.nTopupCompared++;
        metrics.nTopupLowerThanBase += Number(Number(byText.get(textById.get(id))) < weakestBase);
      }
    }
  }
  const followup = "接着说刚才那个吧";
  const followupOrder = await rankLocalMemoryCandidates(service, followup, candidates, 20, [], new AbortController().signal);
  const followupBase = memory.injectionCandidateIds(followup, [], followupOrder.ids, [], resolveRetrievalPlan(followup), followupOrder.scores);
  let followupMisses = 0, dmaeRetains = 0;
  for (const firstBase of bases) {
    const fresh = new Map<string, unknown>([["dmae-enabled", true], ["dmae-state", { version: 1, round: 0, states: {} }]]);
    const isolated = createDmae({ get: <T>(key: string) => structuredClone(fresh.get(key)) as T | undefined, set: (key: string, value: unknown) => { fresh.set(key, structuredClone(value)); }, rootDir: () => base });
    const firstIncluded = isolated.preview(firstBase, nState.entries).selectedIds;
    isolated.commit(firstBase, firstIncluded, nState.entries);
    const target = firstBase[0];
    if (!target || followupBase.includes(target)) continue;
    followupMisses++;
    dmaeRetains += Number(isolated.preview(followupBase, nState.entries).selectedIds.includes(target));
  }
  const unchanged = sourceFiles.every((name, index) => createHash("sha256").update(readFileSync(path.join(base, name))).digest("hex") === hashes[index]);
  console.log("MEMORY_AB_METRICS", JSON.stringify({ ...metrics, differences: metrics.differences.length, followupMisses, dmaeRetains, unchanged, localDmaeRound: read("local-memory.json").l2DmaeRound, nDmaeRound: read("n-dmae-state.json").round }));
  if (!unchanged) throw new Error("测试副本发生变化");
}, 600_000);
