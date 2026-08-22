import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { env, pipeline } from "@xenova/transformers";

const require = createRequire(import.meta.url);
const { selectDynamicMemoryItems } = require("../dist/main/main/memory/memory-facets.js");
const dataDir = process.env.CYRENE_MEMORY_EVAL_DATA_DIR;
if (!dataDir) throw new Error("CYRENE_MEMORY_EVAL_DATA_DIR must point to an isolated data copy");

const memory = JSON.parse(fs.readFileSync(path.join(dataDir, "memory.json"), "utf8"));
const rag = JSON.parse(fs.readFileSync(path.join(dataDir, "rag-data", "memory-store.json"), "utf8"));
const chatIndex = JSON.parse(fs.readFileSync(path.join(dataDir, "cyrene-chats", "index.json"), "utf8"));
const sessionIds = Array.isArray(chatIndex.sessions)
  ? chatIndex.sessions.map((item) => item.id)
  : fs.readdirSync(path.join(dataDir, "cyrene-chats", "sessions")).map((name) => name.replace(/\.json$/u, ""));
const messages = sessionIds.flatMap((id) => {
  const file = path.join(dataDir, "cyrene-chats", "sessions", `${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).messages ?? [] : [];
});

const SCENARIOS = [
  { name: "gift", queryTerms: ["视频通话", "做礼物"], relevant: /礼物|七夕|小摆件|丝带|视频通话/u, split: "calibration" },
  { name: "math", queryTerms: ["泰勒公式"], relevant: /高数|泰勒/u, split: "calibration" },
  { name: "health", queryTerms: ["肌酸激酶"], relevant: /体检|肌酸激酶|肩膀|锻炼/u, split: "calibration" },
  { name: "university", queryTerms: ["大学生活", "充实"], relevant: /大学|录取|报到|具身智能/u, split: "evaluation" },
  { name: "hiking", queryTerms: ["咖啡豆"], relevant: /千岛湖|徒步|咖啡豆/u, split: "evaluation" },
  { name: "drawing", queryTerms: ["Flux1-Dev", "画画"], relevant: /Flux|绘画|画画/u, split: "evaluation" },
  { name: "exercise", queryTerms: ["出去锻炼"], relevant: /锻炼|运动|体检|肌酸激酶|肩膀/u, split: "evaluation" },
  { name: "sleep-promise", queryTerms: ["早睡", "约定"], relevant: /早睡|睡觉|休息/u, split: "evaluation" },
  { name: "all-people-control", query: "今天真的好热欸，我们宿舍所有人都不太想动", relevant: /宿舍.*热|天气炎热/u, split: "control" },
];

const l2ById = new Map((memory.l2 ?? []).map((item) => [item.id, item]));
const items = rag.flatMap((entry) => {
  if (entry.source !== "user_memory" || !Array.isArray(entry.embedding)) return [];
  const l2Id = typeof entry.metadata?.l2Id === "string" ? entry.metadata.l2Id : "";
  const l2 = l2ById.get(l2Id);
  if (!l2 || !["active", "aging"].includes(l2.status)) return [];
  return [{
    id: entry.id,
    l2Id,
    text: entry.text,
    searchText: l2.triggerText?.trim() ? `${l2.content}\n${l2.triggerText}` : l2.content,
    embedding: entry.embedding,
    labelText: `${l2.content} ${l2.triggerText ?? ""} ${l2.sourceQuote ?? ""}`,
  }];
});
if (items.length < 20) throw new Error(`not enough recallable L2 entries: ${items.length}`);

function queryFromChat(scenario) {
  if (scenario.query) return { query: scenario.query, source: "synthetic-control" };
  const hit = [...messages].reverse().find((message) => message.role === "user"
    && scenario.queryTerms.every((term) => String(message.content ?? "").includes(term)));
  if (!hit) throw new Error(`real chat query not found: ${scenario.name}`);
  return { query: String(hit.content), source: "real-chat" };
}

function cosine(a, b) {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index] * b[index];
    aa += a[index] * a[index];
    bb += b[index] * b[index];
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0;
}

function bestF2Threshold(rows) {
  const relevantTotal = rows.filter((row) => row.relevant).length;
  const thresholds = [...new Set(rows.map((row) => row.score))].sort((a, b) => b - a);
  let best = { threshold: Number.POSITIVE_INFINITY, f2: -1, precision: 0, recall: 0 };
  for (const threshold of thresholds) {
    const predicted = rows.filter((row) => row.score >= threshold);
    const tp = predicted.filter((row) => row.relevant).length;
    const precision = predicted.length > 0 ? tp / predicted.length : 0;
    const recall = relevantTotal > 0 ? tp / relevantTotal : 0;
    const f2 = precision + 4 * recall > 0 ? (5 * precision * recall) / (4 * precision + recall) : 0;
    if (f2 > best.f2 || (f2 === best.f2 && precision > best.precision)) {
      best = { threshold, f2, precision, recall };
    }
  }
  return best;
}

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = false;
env.localModelPath = path.resolve("models");
const extractor = await pipeline("feature-extraction", "Xenova/bge-m3", {
  cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
});
const reranker = await pipeline("text-classification", "bge-reranker-base", {
  quantized: true,
  cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
});

async function embed(text) {
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

async function rerank(query, candidates) {
  if (candidates.length === 0) return [];
  const inputs = reranker.tokenizer(candidates.map(() => query), {
    text_pair: candidates.map((item) => item.searchText),
    padding: true,
    truncation: true,
  });
  const outputs = await reranker.model(inputs);
  return candidates.map((item, index) => ({
    ...item,
    score: Number(outputs.logits[index]?.data?.[0] ?? Number.NEGATIVE_INFINITY),
  })).sort((a, b) => b.score - a.score);
}

const runs = [];
for (const scenario of SCENARIOS) {
  const { query, source } = queryFromChat(scenario);
  const queryEmbedding = await embed(query);
  const vectorRanked = items.map((item) => ({ ...item, vectorScore: cosine(queryEmbedding, item.embedding) }))
    .sort((a, b) => b.vectorScore - a.vectorScore)
    .slice(0, 48);
  const reranked48 = await rerank(query, vectorRanked);
  const scoreById = new Map(reranked48.map((item) => [item.id, item.score]));
  const reranked32 = vectorRanked.slice(0, 32).map((item) => ({ ...item, score: scoreById.get(item.id) }))
    .sort((a, b) => b.score - a.score);
  const relevantIds = new Set(items.filter((item) => scenario.relevant.test(item.labelText)).map((item) => item.id));
  runs.push({ scenario, query, source, vectorRanked, reranked32, reranked48, relevantIds });
}

const calibrationRows = runs.filter((run) => run.scenario.split === "calibration").flatMap((run) =>
  run.reranked48.map((item) => ({ score: item.score, relevant: run.relevantIds.has(item.id) })));
const injection = bestF2Threshold(calibrationRows);
const relevantCalibrationScores = calibrationRows.filter((row) => row.relevant).map((row) => row.score).sort((a, b) => a - b);
const expansionThreshold = relevantCalibrationScores[Math.floor(relevantCalibrationScores.length * 0.2)] ?? injection.threshold;

const report = runs.map((run) => {
  const tailStillRelevant = run.vectorRanked.slice(24, 32).some((item) => (scoreBy(run, item.id) ?? -Infinity) >= expansionThreshold);
  const explicitRecallCue = /还记得|之前|以前|上次|当时|说好|约定/u.test(run.query);
  const expanded = explicitRecallCue || tailStillRelevant;
  const ranked = expanded ? run.reranked48 : run.reranked32;
  const selected = selectDynamicMemoryItems(ranked, {
    getText: (item) => item.text,
    getKey: (item) => item.id,
    isStrong: (item) => item.score >= injection.threshold,
    characterBudget: 6000,
    weakStreakLimit: 2,
    maxResults: 20,
  });
  const expected = run.relevantIds.size;
  const candidate32 = run.reranked32.filter((item) => run.relevantIds.has(item.id)).length;
  const candidate48 = run.reranked48.filter((item) => run.relevantIds.has(item.id)).length;
  const selectedRelevant = selected.selected.filter((item) => run.relevantIds.has(item.id)).length;
  return {
    name: run.scenario.name,
    source: run.source,
    split: run.scenario.split,
    expected,
    candidate32,
    candidate48,
    expanded,
    expansionReason: explicitRecallCue ? "recall_cue" : tailStillRelevant ? "relevant_tail" : "none",
    returned: selected.selected.length,
    selectedRelevant,
    additions: selected.selected.length - Math.min(5, ranked.length),
    irrelevantAdditions: selected.selected.slice(5).filter((item) => !run.relevantIds.has(item.id)).length,
    stoppedBy: selected.stoppedBy,
    examined: selected.examined,
    characters: selected.selected.reduce((sum, item) => sum + item.text.length, 0),
  };
});

function scoreBy(run, id) {
  return run.reranked48.find((item) => item.id === id)?.score;
}

const evaluation = report.filter((row) => row.split === "evaluation");
const control = report.find((row) => row.name === "all-people-control");
const summary = {
  data: { messages: messages.length, l2: memory.l2?.length ?? 0, recallableL2: items.length },
  thresholds: { injection, expansionThreshold, characterBudget: 6000, weakStreakLimit: 2 },
  evaluation: {
    scenarios: evaluation.length,
    expected: evaluation.reduce((sum, row) => sum + row.expected, 0),
    selectedRelevant: evaluation.reduce((sum, row) => sum + row.selectedRelevant, 0),
    irrelevantAdditions: evaluation.reduce((sum, row) => sum + row.irrelevantAdditions, 0),
  },
  report,
};
console.log(JSON.stringify(summary, null, 2));

if (report.filter((row) => row.source === "real-chat").length < 7) throw new Error("not enough real-chat scenarios");
if (report.some((row) => row.returned > 20 || row.characters > 6000)) throw new Error("selection limits violated");
if (!control || control.returned > 5) throw new Error("all-people control expanded final injection");
