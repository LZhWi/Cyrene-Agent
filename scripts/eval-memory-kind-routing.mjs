import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pipeline, env } from "@xenova/transformers";

const require = createRequire(import.meta.url);
const { inferQueryKindByRules } = require("../dist/main/main/memory/memory-facets.js");

const PROTOTYPES = [
  ["commitment", "查询明确答应、承诺、双方说好或约定以后要做的事情"],
  ["preference", "查询用户喜欢、讨厌、偏好或长期习惯的事物"],
  ["goal", "查询用户准备行动并实现的计划、任务或目标"],
  ["wish", "查询单方面或双方共同期待、盼望、希望发生但没有行动承诺的未来愿景"],
  ["experience", "查询用户过去经历、做过、去过或已经发生的事件"],
  ["fact", "查询用户明确的个人资料、身份、住址、职业或其他事实"],
  ["emotion", "查询用户明确说出的难过、开心、害怕、焦虑、生气、孤独、紧张等情绪"],
];

const CASES = [
  ["我们有哪些约定", "commitment"], ["我答应过她什么", "commitment"], ["之前说好的事情有哪些", "commitment"],
  ["我平时喜欢什么", "preference"], ["有哪些讨厌的食物", "preference"], ["我的使用习惯是什么", "preference"],
  ["我目前有什么目标", "goal"], ["我计划接下来完成什么", "goal"], ["我准备学会哪些东西", "goal"],
  ["我们共同期待的未来是什么", "wish"], ["我有哪些愿望", "wish"], ["有什么一直盼望发生的事", "wish"],
  ["我以前经历过什么", "experience"], ["上次发生了哪些事情", "experience"], ["我曾经去过哪里", "experience"],
  ["我的个人信息有哪些", "fact"], ["我住在哪里", "fact"], ["我的职业是什么", "fact"],
  ["我明确说过自己什么时候很难过", "emotion"], ["有哪些让我焦虑的事情", "emotion"], ["我什么时候觉得开心", "emotion"],
  ["还记得那件事吗", undefined], ["篮球", undefined], ["礼物", undefined], ["明年的事情", undefined],
  ["她对我意味着什么", undefined], ["等视频通话做好以后会怎么样", undefined],
];

function cosine(a, b) {
  let score = 0;
  for (let index = 0; index < a.length; index += 1) score += a[index] * b[index];
  return score;
}

function metrics(predictions) {
  const exact = predictions.filter((prediction, index) => prediction === CASES[index][1]).length;
  const classified = predictions.filter((prediction) => prediction !== undefined).length;
  const correctClassified = predictions.filter((prediction, index) => prediction !== undefined && prediction === CASES[index][1]).length;
  const expectedCount = CASES.filter((item) => item[1] !== undefined).length;
  return {
    exact,
    accuracy: exact / CASES.length,
    coverage: classified / CASES.length,
    precision: classified > 0 ? correctClassified / classified : 0,
    recall: correctClassified / expectedCount,
  };
}

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.localModelPath = path.resolve("models");
const extractor = await pipeline("feature-extraction", "Xenova/bge-m3", {
  cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
});
async function embed(text) {
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

const prototypeVectors = await Promise.all(PROTOTYPES.map((item) => embed(item[1])));
const queryVectors = await Promise.all(CASES.map((item) => embed(item[0])));
const rules = CASES.map((item) => inferQueryKindByRules(item[0]));
const variants = [
  { threshold: 0.35, margin: 0.02 },
  { threshold: 0.45, margin: 0.03 },
  { threshold: 0.55, margin: 0.04 },
  { threshold: 0.65, margin: 0.05 },
].map(({ threshold, margin }) => {
  const predictions = queryVectors.map((queryVector) => {
    const ranked = PROTOTYPES.map((prototype, index) => ({
      kind: prototype[0], score: cosine(queryVector, prototypeVectors[index]),
    })).sort((a, b) => b.score - a.score);
    return ranked[0].score >= threshold && ranked[0].score - ranked[1].score >= margin ? ranked[0].kind : undefined;
  });
  return { threshold, margin, ...metrics(predictions), predictions };
});

const dataDir = process.env.CYRENE_MEMORY_EVAL_DATA_DIR;
let realData;
if (dataDir) {
  const memory = JSON.parse(fs.readFileSync(path.join(dataDir, "memory.json"), "utf8"));
  const rag = JSON.parse(fs.readFileSync(path.join(dataDir, "rag-data", "memory-store.json"), "utf8"));
  const l2ById = new Map((memory.l2 ?? []).map((item) => [item.id, item]));
  const labelledItems = rag.flatMap((entry) => {
    const l2Id = typeof entry.metadata?.l2Id === "string" ? entry.metadata.l2Id : "";
    const item = l2ById.get(l2Id);
    if (entry.source !== "user_memory" || !Array.isArray(entry.embedding)
      || !item || !["active", "aging"].includes(item.status) || item.facets?.source !== "model") return [];
    return [{ l2Id, embedding: entry.embedding, kinds: item.facets.retrievalKinds ?? [] }];
  });
  const byQuery = new Map();
  const excludedByQuery = new Map();
  for (const item of memory.l2 ?? []) {
    if (!["active", "aging"].includes(item.status) || item.facets?.source !== "model") continue;
    const query = String(item.triggerText || item.sourceQuote || "").trim();
    const kinds = Array.isArray(item.facets.retrievalKinds) ? item.facets.retrievalKinds : [];
    if (!query || kinds.length === 0) continue;
    const expected = byQuery.get(query) ?? new Set();
    kinds.forEach((kind) => expected.add(kind));
    byQuery.set(query, expected);
    const excluded = excludedByQuery.get(query) ?? new Set();
    excluded.add(item.id);
    excludedByQuery.set(query, excluded);
  }
  const samples = [...byQuery].map(([query, expected]) => ({ query, expected: [...expected] }));
  const vectors = await Promise.all(samples.map((sample) => embed(sample.query)));
  const ranked = vectors.map((queryVector) => PROTOTYPES.map((prototype, index) => ({
    kind: prototype[0], score: cosine(queryVector, prototypeVectors[index]),
  })).sort((a, b) => b.score - a.score));
  const rulePredictions = samples.map((sample) => inferQueryKindByRules(sample.query));
  const summarize = (predictions) => {
    const routed = predictions.filter(Boolean).length;
    const correct = predictions.filter((prediction, index) => prediction && samples[index].expected.includes(prediction)).length;
    return {
      routed,
      correct,
      coverage: samples.length > 0 ? correct / samples.length : 0,
      precision: routed > 0 ? correct / routed : 0,
    };
  };
  realData = {
    samples: samples.length,
    rules: summarize(rulePredictions),
    variants: variants.map(({ threshold, margin }) => {
      const vectorPredictions = ranked.map((row) => row[0].score >= threshold && row[0].score - row[1].score >= margin
        ? row[0].kind : undefined);
      const hybridPredictions = vectorPredictions.map((prediction, index) => rulePredictions[index] ?? prediction);
      const eligible = rulePredictions.map((prediction, index) => prediction ? -1 : index).filter((index) => index >= 0);
      const fallbackRouted = eligible.filter((index) => vectorPredictions[index]).length;
      const fallbackCorrect = eligible.filter((index) => vectorPredictions[index]
        && samples[index].expected.includes(vectorPredictions[index])).length;
      return {
        threshold,
        margin,
        vector: summarize(vectorPredictions),
        hybrid: summarize(hybridPredictions),
        fallbackEligible: eligible.length,
        fallbackRouted,
        fallbackCorrect,
        fallbackPrecision: fallbackRouted > 0 ? fallbackCorrect / fallbackRouted : 0,
      };
    }),
  };

  const semanticRoute = (queryVector, excluded, { minSimilarity, minShare, minMargin }) => {
    const neighbours = labelledItems
      .filter((item) => !excluded?.has(item.l2Id))
      .map((item) => ({ ...item, similarity: cosine(queryVector, item.embedding) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);
    if (!neighbours[0] || neighbours[0].similarity < minSimilarity) return undefined;
    const votes = new Map();
    for (const neighbour of neighbours) {
      const kinds = neighbour.kinds.length > 0 ? neighbour.kinds : [];
      for (const kind of kinds) votes.set(kind, (votes.get(kind) ?? 0) + Math.max(0, neighbour.similarity) / kinds.length);
    }
    const rankedVotes = [...votes].sort((a, b) => b[1] - a[1]);
    const total = rankedVotes.reduce((sum, item) => sum + item[1], 0);
    const share = total > 0 ? rankedVotes[0]?.[1] / total : 0;
    const margin = total > 0 ? ((rankedVotes[0]?.[1] ?? 0) - (rankedVotes[1]?.[1] ?? 0)) / total : 0;
    return share >= minShare && margin >= minMargin ? rankedVotes[0][0] : undefined;
  };
  const semanticConfigs = [
    { minSimilarity: 0.45, minShare: 0.4, minMargin: 0.1 },
    { minSimilarity: 0.55, minShare: 0.45, minMargin: 0.15 },
    { minSimilarity: 0.65, minShare: 0.5, minMargin: 0.2 },
    { minSimilarity: 0.75, minShare: 0.55, minMargin: 0.25 },
  ];
  const controlVectors = queryVectors.slice(CASES.findIndex((item) => item[1] === undefined));
  realData.semanticNeighbourFallback = semanticConfigs.map((config) => {
    const fallback = vectors.map((vector, index) => semanticRoute(vector, excludedByQuery.get(samples[index].query), config));
    const hybrid = fallback.map((prediction, index) => rulePredictions[index] ?? prediction);
    const eligible = rulePredictions.map((prediction, index) => prediction ? -1 : index).filter((index) => index >= 0);
    const fallbackRouted = eligible.filter((index) => fallback[index]).length;
    const fallbackCorrect = eligible.filter((index) => fallback[index]
      && samples[index].expected.includes(fallback[index])).length;
    const controlPredictions = controlVectors.map((vector) => semanticRoute(vector, undefined, config));
    return {
      ...config,
      hybrid: summarize(hybrid),
      fallbackEligible: eligible.length,
      fallbackRouted,
      fallbackCorrect,
      fallbackPrecision: fallbackRouted > 0 ? fallbackCorrect / fallbackRouted : 0,
      ambiguousControlFalsePositives: controlPredictions.filter(Boolean).length,
    };
  });
}

console.log(JSON.stringify({
  synthetic: { cases: CASES.length, rules: { ...metrics(rules), predictions: rules }, variants },
  realData,
}, null, 2));
