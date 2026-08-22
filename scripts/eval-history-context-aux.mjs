import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const projectRoot = process.cwd();
const userData = path.resolve(valueAfter("--user-data") ?? path.join(process.env.APPDATA ?? os.homedir(), "live2d-cyrene"));
const caseCount = Math.max(6, Math.min(20, Number(valueAfter("--count") ?? 10) || 10));
const listCases = args.includes("--list-cases");
const summaryOnly = args.includes("--summary-only");
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, "dist", "main", relativePath)).href);
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const normalize = (text) => text.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
const clip = (text, max = 100) => {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
};
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const cues = /这个|那个|这样|它|感觉|画面|效果|满意|喜欢|好看|浪漫|接进去|做出来|听起来|看起来|确实|真的|那就|好呀|嗯嗯|欸/u;
const bigrams = (text) => {
  const compact = normalize(text).replace(/\s+/gu, "");
  return new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2)));
};
const overlap = (left, right) => {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared++;
  return shared / Math.min(a.size, b.size);
};
const continuityLabels = new Map([
  ["1787339188886", { label: "same", reason: "直接回应上一条关于时间已晚和休息的提醒" }],
  ["1787152691276", { label: "same", reason: "延续画面验收、接入承诺和休息安排" }],
  ["1787152506018", { label: "same", reason: "直接评价上一条生成画面描述与效果" }],
  ["1787151886634", { label: "same", reason: "继续讨论 Flux1-Dev 画画功能与画面选择" }],
  ["1787151647536", { label: "same", reason: "继续讨论已完成的电脑画画功能接入" }],
  ["1787151061706", { label: "same", reason: "承接 DeepSeek 文件问题并说明功能已自行完成" }],
  ["1787111584627", { label: "switch", reason: "从礼物和视频陪伴明确切换到 DeepSeek 文件夹问题" }],
  ["1787062411502", { label: "same", reason: "继续讨论七夕礼物和明年补偿的约定" }],
  ["1787062172074", { label: "switch", reason: "从具身智能学习明确切换到七夕礼物" }],
  ["1787061781187", { label: "same", reason: "继续讨论具身智能方向及学习难度" }],
]);
const extractAssistantKeySentences = (text) => {
  const clean = normalize(text).replace(/\[sticker:[^\]]+\]/giu, "");
  const sentences = clean
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((sentence, index) => ({ sentence: sentence.trim(), index }))
    .filter((item) => item.sentence.length >= 12)
    .map((item) => {
      const asciiTerms = item.sentence.match(/[A-Za-z][A-Za-z0-9._-]{2,}/gu)?.length ?? 0;
      const concreteTerms = item.sentence.match(/画|礼物|功能|系统|项目|学校|专业|身体|视频|照片|音乐|舞|代码|模型|旅行|海边|花|游戏/gu)?.length ?? 0;
      const fillerPenalty = /^(?:嗯|唔|呜哇|嘿嘿|哎呀|哈哈|欸)[……，、~～\s]*/u.test(item.sentence) ? 18 : 0;
      return {
        ...item,
        score: Math.min(item.sentence.length, 180) + asciiTerms * 18 + concreteTerms * 10 - fillerPenalty,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);
  return sentences.join(" ").slice(0, 320) || clean.slice(0, 320);
};

const runtimePaths = await importBuilt(path.join("main", "runtime", "runtime-paths.js"));
runtimePaths.setAppPathProvider({
  getPath(name) {
    if (name === "userData") return userData;
    if (name === "home") return os.homedir();
    if (name === "temp") return os.tmpdir();
    return path.join(userData, name);
  },
  getAppPath() { return projectRoot; },
});
const rag = await importBuilt(path.join("main", "rag", "index.js"));
const embeddingModule = await importBuilt(path.join("main", "rag", "embedding.js"));
const diagnostics = await importBuilt(path.join("main", "orchestrator", "history-retrieval-diagnostics.js"));
const historyTools = await importBuilt(path.join("main", "orchestrator", "history-tools.js"));
const rerankerModule = await importBuilt(path.join("main", "rag", "reranker.js"));

const settingsPath = path.join(userData, "model-settings.json");
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
const embeddingModel = settings.embeddingModel === "bgem3" ? "bgem3" : "minilm";
await rag.initRAG("auto", undefined, undefined, embeddingModel);
const continuityEmbedder = embeddingModule.createLocalEmbeddingProvider(embeddingModel);
if (!continuityEmbedder) throw new Error(`Local embedding model is unavailable: ${embeddingModel}`);
const reranker = await rerankerModule.createStandardReranker();

const chatIndexPath = path.join(userData, "cyrene-chats", "index.json");
const vectorPath = path.join(userData, "rag-data", "memory-store.json");
const sessionIndex = JSON.parse(fs.readFileSync(chatIndexPath, "utf8"));
const sessionFiles = sessionIndex
  .filter((item) => typeof item.id === "string")
  .map((item) => path.join(userData, "cyrene-chats", "sessions", `${item.id}.json`))
  .filter((file) => fs.existsSync(file));
const relatedUserDataFiles = [settingsPath, path.join(userData, "entity-graph.json"), path.join(userData, "worldbook-state.json")]
  .filter((file) => fs.existsSync(file));
const before = new Map([chatIndexPath, vectorPath, ...sessionFiles, ...relatedUserDataFiles].map((file) => [file, digest(file)]));
const sessions = sessionFiles.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));

const candidates = [];
for (let sessionPosition = 0; sessionPosition < sessions.length; sessionPosition++) {
  const session = sessions[sessionPosition];
  const sessionId = session.id ?? sessionIndex[sessionPosition]?.id ?? `session-${sessionPosition}`;
  const messages = (session.messages ?? []).filter((message) =>
    (message.role === "user" || message.role === "model")
    && typeof message.content === "string"
    && typeof message.at === "number"
    && typeof message.id === "string");
  for (let index = 2; index < messages.length; index++) {
    const previousUser = messages[index - 2];
    const previousAssistant = messages[index - 1];
    const currentUser = messages[index];
    if (previousUser.role !== "user" || previousAssistant.role !== "model" || currentUser.role !== "user") continue;
    const current = normalize(currentUser.content);
    const assistant = normalize(previousAssistant.content);
    if (current.length < 8 || current.length > 180 || assistant.length < 80 || !cues.test(current)) continue;
    candidates.push({ sessionId, previousUser, previousAssistant, currentUser });
  }
}
const cases = [];
for (const candidate of candidates.sort((a, b) => b.currentUser.at - a.currentUser.at)) {
  const topic = `${candidate.previousAssistant.content}\n${candidate.currentUser.content}`;
  if (cases.some((item) => overlap(topic, `${item.previousAssistant.content}\n${item.currentUser.content}`) >= 0.55)) continue;
  cases.push(candidate);
  if (cases.length >= caseCount) break;
}
if (cases.length < 6) throw new Error(`Only ${cases.length} suitable real conversation cases were found`);

if (listCases) {
  console.log(JSON.stringify(cases.map((item) => ({
    id: item.currentUser.id,
    previousUser: clip(item.previousUser.content, 180),
    previousAssistant: clip(item.previousAssistant.content, 240),
    currentUser: clip(item.currentUser.content, 180),
  })), null, 2));
  for (const [file, hash] of before) {
    if (digest(file) !== hash) throw new Error(`Read-only hash check failed: ${file}`);
  }
  console.log(`[HistoryAssistantContextAB] read-only hash check passed for ${before.size} source files`);
  process.exit(0);
}
const unlabeledCases = cases.filter((item) => !continuityLabels.has(item.currentUser.id));
if (unlabeledCases.length) {
  throw new Error(`Missing manual continuity labels for: ${unlabeledCases.map((item) => item.currentUser.id).join(", ")}`);
}

const rows = [];
for (const item of cases) {
  const cutoff = item.currentUser.at - 90 * 24 * 60 * 60 * 1000;
  const excludedIds = new Set([item.previousUser.id, item.previousAssistant.id, item.currentUser.id]);
  const excludedTexts = new Set([item.previousUser.content, item.previousAssistant.content, item.currentUser.content].map(normalize));
  const authoritative = sessions.flatMap((session, sessionPosition) => {
    const sessionId = session.id ?? sessionIndex[sessionPosition]?.id ?? `session-${sessionPosition}`;
    return (session.messages ?? []).flatMap((message) => {
      if (message.at < cutoff || message.at >= item.currentUser.at || excludedIds.has(message.id)) return [];
      if (message.role !== "user" && message.role !== "model") return [];
      const role = message.role === "model" ? "assistant" : "user";
      return [{
        text: message.content,
        createdAt: message.at,
        weight: 1,
        metadata: { sessionId, role, turnId: message.id, occurrences: [{ sessionId, role, ts: message.at, turnId: message.id }] },
      }];
    });
  });
  const authoritativeTexts = new Set(authoritative.map((entry) => normalize(entry.text)));
  const search = async (query, depth, options = {}) => {
    const hits = await rag.searchHistoryEntries(query, depth + 64, {
      recordRecall: false,
      createdAfter: cutoff,
      rawScore: options.rawScore,
      semanticOnly: options.semanticOnly,
    });
    return hits.filter((hit) =>
      hit.createdAt < item.currentUser.at
      && !excludedTexts.has(normalize(hit.text))
      && authoritativeTexts.has(normalize(hit.text))).slice(0, depth);
  };
  const run = async (userQuery, toolQuery) => {
    let stageCandidates = [];
    let selected = [];
    const baseline = await search(userQuery, 5);
    const record = await diagnostics.runHistoryRetrievalV2Shadow({
      userQuery,
      toolQuery,
      days: 90,
      baseline,
      search: (query, depth) => search(query, depth),
      semanticSearch: (query, depth) => search(query, depth, { rawScore: true, semanticOnly: true }),
      rerank: async (query, documents) => historyTools.diversifySandboxRerankResults(
        await historyTools.rerankHistoryCandidatesForSandbox(
          query,
          documents,
          (focusedQuery, focusedDocuments) => reranker.rerank(focusedQuery, focusedDocuments),
        ),
        stageCandidates,
        5,
      ),
      expandCandidates: (hits) => historyTools.expandHistoryHitsWithSentenceWindows(
        historyTools.expandHistoryHitsWithAdjacentTurns(hits, authoritative, new Set(), {
          createdAfter: cutoff,
          createdBefore: item.currentUser.at,
        }),
      ),
      enabled: true,
      source: "sandbox",
      writeLog: false,
      createdBefore: item.currentUser.at,
      finalK: 5,
      onCandidates: (hits) => { stageCandidates = hits; },
      onResult: (hits) => { selected = hits; },
    });
    return {
      selected: historyTools.filterHistoryHitsByRelevance(selected, record.method).slice(0, 5),
      candidateCount: record.candidateCount,
    };
  };

  const currentQuery = normalize(item.currentUser.content);
  const assistantContext = normalize(item.previousAssistant.content).slice(0, 520);
  const assistantKeySentences = extractAssistantKeySentences(item.previousAssistant.content);
  const previousUserTopic = normalize(item.previousUser.content).slice(0, 240);
  const bridgeContext = `${previousUserTopic}\n${assistantKeySentences}`;
  const [currentEmbedding, contextEmbedding] = await continuityEmbedder.embedBatch([currentQuery, bridgeContext]);
  const continuitySimilarity = currentEmbedding.reduce((sum, value, index) => sum + value * contextEmbedding[index], 0);
  const continuityLabel = continuityLabels.get(item.currentUser.id);
  const referenceQuery = continuityLabel.label === "same"
    ? [normalize(item.previousUser.content).slice(0, 260), assistantContext, currentQuery].join("\n")
    : currentQuery;
  const variants = {
    baseline: await run(currentQuery, currentQuery),
    topicBridge: await run(currentQuery, `${bridgeContext}\n${currentQuery}`),
  };
  const oracle = await run(referenceQuery, referenceQuery);
  const oracleTexts = new Set(oracle.selected.map((hit) => normalize(hit.text)));
  const union = [...new Set(Object.values(variants).flatMap((variant) => variant.selected.map((hit) => hit.text)))];
  const judged = await reranker.rerank(referenceQuery, union);
  const scores = new Map(judged.map((result) => [normalize(result.text), result.score]));
  const baselineTexts = new Set(variants.baseline.selected.map((hit) => normalize(hit.text)));
  const variantRows = Object.fromEntries(Object.entries(variants).map(([name, variant]) => {
    const added = variant.selected.filter((hit) => !baselineTexts.has(normalize(hit.text)));
    return [name, {
      oracleHits: variant.selected.filter((hit) => oracleTexts.has(normalize(hit.text))).length,
      meanContextScore: mean(variant.selected.map((hit) => scores.get(normalize(hit.text)) ?? -20)),
      candidateCount: variant.candidateCount,
      addedLowContext: added.filter((hit) => (scores.get(normalize(hit.text)) ?? -20) < -6).length,
      added: added.slice(0, 2).map((hit) => ({
        text: clip(hit.text, 72),
        contextScore: Number((scores.get(normalize(hit.text)) ?? -20).toFixed(4)),
      })),
    }];
  }));
  rows.push({
    id: item.currentUser.id,
    query: clip(currentQuery),
    keySentences: clip(assistantKeySentences),
    continuity: {
      ...continuityLabel,
      similarity: Number(continuitySimilarity.toFixed(6)),
    },
    oracleSize: oracleTexts.size,
    variants: variantRows,
    oracleTop: oracle.selected.slice(0, 3).map((hit) => clip(hit.text, 72)),
  });
}

const baselineHits = rows.map((row) => row.variants.baseline.oracleHits);
const summarizeVariant = (name) => {
  const values = rows.map((row) => row.variants[name]);
  return {
    meanOracleHitsAt5: Number(mean(values.map((value) => value.oracleHits)).toFixed(3)),
    meanContextScore: Number(mean(values.map((value) => value.meanContextScore)).toFixed(4)),
    meanCandidates: Number(mean(values.map((value) => value.candidateCount)).toFixed(1)),
    improvedVsBaseline: values.filter((value, index) => value.oracleHits > baselineHits[index]).length,
    unchangedVsBaseline: values.filter((value, index) => value.oracleHits === baselineHits[index]).length,
    regressedVsBaseline: values.filter((value, index) => value.oracleHits < baselineHits[index]).length,
    addedLowContext: values.reduce((sum, value) => sum + value.addedLowContext, 0),
  };
};
const thresholds = Array.from({ length: 25 }, (_, index) => Number((0.3 + index * 0.025).toFixed(3)));
const summarizeGate = (threshold) => {
  const chosen = rows.map((row) => row.continuity.similarity >= threshold ? row.variants.topicBridge : row.variants.baseline);
  const enabled = rows.map((row) => row.continuity.similarity >= threshold);
  const switchRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.continuity.label === "switch");
  const sameRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.continuity.label === "same");
  const oracleHitTotal = chosen.reduce((sum, value) => sum + value.oracleHits, 0);
  const oracleTopKTotal = rows.reduce((sum, row) => sum + row.oracleSize, 0);
  return {
    threshold,
    enabled: enabled.filter(Boolean).length,
    enabledRate: Number(mean(enabled.map(Number)).toFixed(3)),
    falseEnabled: switchRows.filter(({ index }) => enabled[index]).length,
    falseEnableRate: Number(mean(switchRows.map(({ index }) => Number(enabled[index]))).toFixed(3)),
    sameTopicEnableRate: Number(mean(sameRows.map(({ index }) => Number(enabled[index]))).toFixed(3)),
    meanOracleHitsAt5: Number(mean(chosen.map((value) => value.oracleHits)).toFixed(3)),
    referenceTopKCoverage: Number((oracleHitTotal / Math.max(1, oracleTopKTotal)).toFixed(4)),
    meanContextScore: Number(mean(chosen.map((value) => value.meanContextScore)).toFixed(4)),
    meanCandidates: Number(mean(chosen.map((value) => value.candidateCount)).toFixed(1)),
    improvedVsBaseline: chosen.filter((value, index) => value.oracleHits > baselineHits[index]).length,
    unchangedVsBaseline: chosen.filter((value, index) => value.oracleHits === baselineHits[index]).length,
    regressedVsBaseline: chosen.filter((value, index) => value.oracleHits < baselineHits[index]).length,
  };
};
const summary = {
  cases: rows.length,
  labels: {
    same: rows.filter((row) => row.continuity.label === "same").length,
    switch: rows.filter((row) => row.continuity.label === "switch").length,
  },
  baseline: summarizeVariant("baseline"),
  topicBridge: summarizeVariant("topicBridge"),
  gates: thresholds.map(summarizeGate),
};
for (const [file, hash] of before) {
  if (digest(file) !== hash) throw new Error(`Read-only hash check failed: ${file}`);
}
const outputRows = summaryOnly ? rows.map((row) => ({
  id: row.id,
  query: row.query,
  continuity: row.continuity,
  baseline: row.variants.baseline,
  topicBridge: row.variants.topicBridge,
})) : rows;
console.log(JSON.stringify({ summary, rows: outputRows }, null, 2));
console.log(`[HistoryAssistantContextAB] read-only hash check passed for ${before.size} source files`);
