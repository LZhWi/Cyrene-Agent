import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const sourceUserData = path.join(process.env.APPDATA ?? os.homedir(), "live2d-cyrene");
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-retrieval-profile-"));
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, "dist", "main", relativePath)).href);
const digest = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

function copyIfPresent(relativePath) {
  const source = path.join(sourceUserData, relativePath);
  if (!fs.existsSync(source)) return;
  const target = path.join(isolatedUserData, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(fullPath));
    else if (entry.isFile()) out.push(fullPath);
  }
  return out;
}

async function measure(label, operation) {
  const intervalMs = 5;
  let expected = performance.now() + intervalMs;
  let maxEventLoopLagMs = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxEventLoopLagMs = Math.max(maxEventLoopLagMs, now - expected);
    expected = now + intervalMs;
    ticks += 1;
  }, intervalMs);
  await new Promise((resolve) => setImmediate(resolve));
  const startedAt = performance.now();
  const value = await operation();
  const durationMs = performance.now() - startedAt;
  await new Promise((resolve) => setTimeout(resolve, intervalMs * 2));
  clearInterval(timer);
  return {
    label,
    durationMs: Number(durationMs.toFixed(1)),
    maxEventLoopLagMs: Number(maxEventLoopLagMs.toFixed(1)),
    timerTicks: ticks,
    resultCount: Array.isArray(value) ? value.length : (typeof value === "string" && value ? 1 : 0),
  };
}

try {
  for (const relativePath of [
    "rag-data",
    "memory.json",
    "memory.last-good.json",
    "entity-graph.json",
    "worldbook-state.json",
    "model-settings.json",
  ]) copyIfPresent(relativePath);

  const sourceFiles = [
    ...listFiles(path.join(sourceUserData, "rag-data")),
    ...["memory.json", "memory.last-good.json", "entity-graph.json", "worldbook-state.json", "model-settings.json"]
      .map((name) => path.join(sourceUserData, name))
      .filter(fs.existsSync),
  ];
  const sourceHashes = new Map(sourceFiles.map((filePath) => [filePath, digest(filePath)]));

  const runtimePaths = await importBuilt(path.join("main", "runtime", "runtime-paths.js"));
  runtimePaths.setAppPathProvider({
    getPath(name) {
      if (name === "userData") return isolatedUserData;
      if (name === "home") return os.homedir();
      if (name === "temp") return os.tmpdir();
      return path.join(isolatedUserData, name);
    },
    getAppPath() { return projectRoot; },
  });
  const rag = await importBuilt(path.join("main", "rag", "index.js"));
  const reranker = await importBuilt(path.join("main", "rag", "reranker.js"));
  const history = await importBuilt(path.join("main", "orchestrator", "history-tools.js"));
  const settingsPath = path.join(isolatedUserData, "model-settings.json");
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
  const embeddingModel = settings.embeddingModel === "bgem3" ? "bgem3" : "minilm";
  const rerankerMode = ["light", "standard"].includes(settings.rerankerMode) ? settings.rerankerMode : "none";

  const measurements = [];
  measurements.push(await measure("initRAG", () => rag.initRAG("auto", undefined, undefined, embeddingModel)));
  reranker.configureRerankerForLazyInit(rerankerMode);
  const historyCount = rag.getEntriesBySource("chat_history").length;
  const memoryCount = rag.getEntriesBySource("user_memory").length;
  measurements.push(await measure("history-bm25-preflight", () => rag.searchHistoryEntries(
    "之前聊过的事情",
    1,
    { bm25Only: true, recordRecall: false },
  )));
  measurements.push(await measure("history-hybrid", () => rag.searchHistoryEntries(
    "还记得我们以前讨论过的计划吗",
    5,
    { recordRecall: false },
  )));
  measurements.push(await measure("history-full-v2", () => history.runHistoryAutoInjection(
    "还记得我们上次说过的安排吗",
    90,
  )));
  measurements.push(await measure("memory-local", () => rag.searchMemoryEntries(
    "我的长期偏好和重要约定",
    "user_memory",
    5,
    { recordRecall: false, facetFusion: true },
  )));

  for (const [filePath, beforeHash] of sourceHashes) {
    if (digest(filePath) !== beforeHash) throw new Error(`source changed: ${filePath}`);
  }
  console.log(JSON.stringify({
    ok: true,
    isolated: true,
    sourceFilesUnchanged: sourceHashes.size,
    corpus: { historyCount, memoryCount },
    settings: { embeddingModel, rerankerMode },
    measurements,
  }, null, 2));
} finally {
  fs.rmSync(isolatedUserData, { recursive: true, force: true });
}
