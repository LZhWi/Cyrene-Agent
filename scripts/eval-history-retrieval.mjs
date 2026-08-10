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
const hasFlag = (flag) => args.includes(flag);
const projectRoot = process.cwd();
const userData = path.resolve(valueAfter("--user-data") ?? path.join(process.env.APPDATA ?? os.homedir(), "live2d-cyrene"));
const defaultCasesFile = path.join(userData, "rag-data", "eval", "history-retrieval-cases.json");
const casesFile = path.resolve(valueAfter("--cases") ?? defaultCasesFile);
const generate = hasFlag("--generate");
const generateRuntimeQueries = hasFlag("--generate-runtime-queries");
const force = hasFlag("--force");
const rerankerMode = valueAfter("--reranker") ?? "none";
const count = Math.max(1, Math.min(50, Number(valueAfter("--count") ?? 20) || 20));

const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, "dist", "main", relativePath)).href);
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
const diagnostics = await importBuilt(path.join("main", "orchestrator", "history-retrieval-diagnostics.js"));

function loadSettings() {
  const file = path.join(userData, "model-settings.json");
  if (!fs.existsSync(file)) {
    return { provider: "", baseUrl: "", model: "", apiKey: "", embeddingModel: "minilm" };
  }
  const settings = JSON.parse(fs.readFileSync(file, "utf8"));
  const profile = settings.perProvider?.[settings.provider] ?? settings;
  return {
    provider: settings.provider,
    baseUrl: profile.baseUrl ?? settings.baseUrl,
    model: profile.model ?? settings.model,
    apiKey: profile.apiKey ?? settings.apiKey,
    explicitTransport: profile.explicitTransport,
    embeddingModel: settings.embeddingModel === "bgem3" ? "bgem3" : "minilm",
  };
}

async function callDatasetGenerator(settings, system, user) {
  const vendors = await importBuilt(path.join("main", "orchestrator", "vendors", "index.js"));
  const adapter = vendors.getAdapterForConfig(settings);
  const request = adapter.buildRequest({
    model: settings.model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    maxTokens: 4000,
    stream: false,
  }, { ...settings, reasoning: { mode: "off" } });
  const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body });
  if (!response.ok) throw new Error(`Dataset generation failed: HTTP ${response.status} ${await response.text()}`);
  return adapter.parseResponse(await response.json()).text;
}

const settings = loadSettings();
await rag.initRAG("auto", undefined, undefined, settings.embeddingModel);

try {
  if (generate) {
    if (fs.existsSync(casesFile) && !force) {
      throw new Error(`Evaluation dataset already exists: ${casesFile}. Reuse it, or pass --force to replace it.`);
    }
    if (!settings.apiKey || !settings.baseUrl || !settings.model) throw new Error("Chat reply model is not fully configured");
    const generationCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const availableEntries = rag.getEntriesBySource("chat_history")
      .filter((entry) => (
        typeof entry.text === "string" && entry.text.trim().length >= 8 && entry.createdAt >= generationCutoff
      ))
      .sort((a, b) => a.createdAt - b.createdAt);
    const sampleSize = Math.min(60, availableEntries.length);
    const entries = Array.from({ length: sampleSize }, (_, index) => {
      const sourceIndex = sampleSize === 1
        ? availableEntries.length - 1
        : Math.round(index * (availableEntries.length - 1) / (sampleSize - 1));
      return availableEntries[sourceIndex];
    })
      .map((entry) => ({ id: entry.id, text: entry.text, createdAt: entry.createdAt }));
    if (entries.length === 0) throw new Error("No chat_history entries are available for dataset generation");
    const prompt = diagnostics.buildHistoryEvalGenerationPrompt(entries, count);
    const output = await callDatasetGenerator(settings, prompt.system, prompt.user);
    const generatedCases = diagnostics.parseGeneratedHistoryEvalCases(output);
    const sampledTexts = entries.map((entry) => entry.text);
    for (const testCase of generatedCases) {
      if (!testCase.expectedAny.some((anchor) => sampledTexts.some((text) => text.includes(anchor)))) {
        throw new Error(`Generated case ${testCase.id} has no expectedAny anchor in the sampled history`);
      }
    }
    fs.mkdirSync(path.dirname(casesFile), { recursive: true });
    fs.writeFileSync(casesFile, JSON.stringify(generatedCases, null, 2), "utf8");
    console.log(`[HistoryEval] generated ${generatedCases.length} cases with one isolated model call: ${casesFile}`);
  }

  if (!fs.existsSync(casesFile)) {
    throw new Error(`Evaluation dataset not found: ${casesFile}. Create it with --generate or pass --cases <file>.`);
  }
  const cases = JSON.parse(fs.readFileSync(casesFile, "utf8"));
  const runtimeQueriesFile = path.join(path.dirname(casesFile), "history-retrieval-runtime-queries.json");
  if (generateRuntimeQueries) {
    if (fs.existsSync(runtimeQueriesFile) && !force) {
      throw new Error(`Runtime query dataset already exists: ${runtimeQueriesFile}. Reuse it, or pass --force to replace it.`);
    }
    if (!settings.apiKey || !settings.baseUrl || !settings.model) throw new Error("Chat reply model is not fully configured");
    const prompt = diagnostics.buildRuntimeQueryRewritePrompt(cases);
    const output = await callDatasetGenerator(settings, prompt.system, prompt.user);
    const rewrites = diagnostics.parseRuntimeQueryRewrites(output, cases.map((item) => item.id));
    fs.writeFileSync(runtimeQueriesFile, JSON.stringify(rewrites, null, 2), "utf8");
    console.log(`[HistoryEval] generated ${Object.keys(rewrites).length} answer-blind runtime queries with one isolated model call: ${runtimeQueriesFile}`);
  }

  const results = await diagnostics.evaluateHistoryRetrieval(
    cases,
    (query, topK) => rag.searchHistoryEntries(query, topK, { recordRecall: false }),
  );
  const grouped = new Map();
  for (const result of results) {
    const key = `${result.variant}\t${result.depth}`;
    const current = grouped.get(key) ?? { cases: 0, hits: 0, reciprocalRank: 0, chars: 0 };
    current.cases++;
    if (result.hit) current.hits++;
    if (result.firstRelevantRank) current.reciprocalRank += 1 / result.firstRelevantRank;
    current.chars += result.estimatedChars;
    grouped.set(key, current);
  }
  console.table([...grouped.entries()].map(([key, value]) => {
    const [variant, depth] = key.split("\t");
    return {
      variant,
      depth: Number(depth),
      hitRate: `${((value.hits / value.cases) * 100).toFixed(1)}%`,
      mrr: (value.reciprocalRank / value.cases).toFixed(3),
      avgChars: Math.round(value.chars / value.cases),
    };
  }));
  const resultFile = path.join(path.dirname(casesFile), `history-retrieval-results-${Date.now()}.json`);
  fs.writeFileSync(resultFile, JSON.stringify(results, null, 2), "utf8");
  console.log(`[HistoryEval] detailed results: ${resultFile}`);

  if (fs.existsSync(runtimeQueriesFile)) {
    const rewrites = JSON.parse(fs.readFileSync(runtimeQueriesFile, "utf8"));
    const blindQueryResults = await diagnostics.evaluateHistoryRetrieval(
      cases.map((testCase) => ({ ...testCase, query: rewrites[testCase.id], shadowQueries: [] })),
      (query, topK) => rag.searchHistoryEntries(query, topK, { recordRecall: false }),
    );
    console.table([5, 8, 12].map((depth) => {
      const rows = blindQueryResults.filter((result) => result.depth === depth);
      const hits = rows.filter((result) => result.hit).length;
      const reciprocalRank = rows.reduce((sum, result) => sum + (result.firstRelevantRank ? 1 / result.firstRelevantRank : 0), 0);
      return {
        variant: "answer-blind-rewrite",
        depth,
        hitRate: `${((hits / rows.length) * 100).toFixed(1)}%`,
        mrr: (reciprocalRank / rows.length).toFixed(3),
        avgChars: Math.round(rows.reduce((sum, result) => sum + result.estimatedChars, 0) / rows.length),
      };
    }));
    let reranker;
    if (rerankerMode !== "none") {
      if (rerankerMode !== "standard") throw new Error(`Unsupported reranker mode for history evaluation: ${rerankerMode}`);
      const rerankerModule = await importBuilt(path.join("main", "rag", "reranker.js"));
      await rerankerModule.initReranker("standard");
      reranker = rerankerModule.getReranker();
      if (!reranker) throw new Error("Standard reranker is not installed or failed to initialize");
    }
    const fusionResults = await diagnostics.evaluateFusedHistoryRetrieval({
      cases,
      rewrites,
      search: (query, topK) => rag.searchHistoryEntries(query, topK, { recordRecall: false }),
      ...(reranker ? { rerank: (query, documents) => reranker.rerank(query, documents) } : {}),
    });
    const fusionGroups = new Map();
    for (const result of fusionResults) {
      const key = `${result.method}\t${result.candidateDepth}\t${result.finalK}`;
      const current = fusionGroups.get(key) ?? { cases: 0, hits: 0, candidateHits: 0, reciprocalRank: 0, chars: 0, candidates: 0 };
      current.cases++;
      if (result.hit) current.hits++;
      if (result.candidateHit) current.candidateHits++;
      if (result.firstRelevantRank) current.reciprocalRank += 1 / result.firstRelevantRank;
      current.chars += result.estimatedChars;
      current.candidates += result.candidateCount;
      fusionGroups.set(key, current);
    }
    console.table([...fusionGroups.entries()].map(([key, value]) => {
      const [method, candidateDepth, finalK] = key.split("\t");
      return {
        method,
        candidateDepth: Number(candidateDepth),
        finalK: Number(finalK),
        hitRate: `${((value.hits / value.cases) * 100).toFixed(1)}%`,
        candidateCoverage: `${((value.candidateHits / value.cases) * 100).toFixed(1)}%`,
        mrr: (value.reciprocalRank / value.cases).toFixed(3),
        avgCandidates: (value.candidates / value.cases).toFixed(1),
        avgChars: Math.round(value.chars / value.cases),
      };
    }));
    const fusionFile = path.join(path.dirname(casesFile), `history-retrieval-fusion-results-${Date.now()}.json`);
    fs.writeFileSync(fusionFile, JSON.stringify(fusionResults, null, 2), "utf8");
    console.log(`[HistoryEval] fusion results: ${fusionFile}`);
  }
} finally {
  rag.resetRAG();
}
