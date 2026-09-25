// Reranker module — cross-encoder reranking for RAG
// 只支持 bge-reranker-base，不再提供 light 版本
import * as path from "path";
import * as os from "os";
import { getProjectModelBaseDir } from "./model-status";
import { applyOnnxCpuSessionPolicy } from "./onnx-session-policy";

// ── Types ──
export interface RerankerProvider {
  rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>>;
  readonly name: string;
}

// ── ESM import helper (same pattern as embedding.ts) ──
const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

// ── Pipeline cache ──
let standardPipeline: any = null;

async function loadRerankerPipeline(modelDir: string): Promise<any> {
  await applyOnnxCpuSessionPolicy();
  const { pipeline, env } = await importEsm("@xenova/transformers");

  const originalPath = env.localModelPath;
  const modelsDir = getProjectModelBaseDir("reranker", "standard");
  if (!modelsDir) throw new Error("Local reranker model is not installed");
  env.localModelPath = modelsDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useBrowserCache = false;

  try {
    const pipe = await pipeline("text-classification", modelDir, {
      quantized: true,
      cache_dir: path.join(os.homedir(), ".cache", "huggingface"),
    });
    console.log(`[Reranker] pipeline "${modelDir}" loaded OK`);
    return pipe;
  } finally {
    env.localModelPath = originalPath;
  }
}

/** Cross-encoder 必须把 query/document 作为 tokenizer 的 text/text_pair 输入。 */
export async function rerankDocumentsWithPipeline(
  pipeline: any,
  query: string,
  documents: string[],
): Promise<Array<{ text: string; score: number }>> {
  if (documents.length === 0) return [];
  const modelInputs = pipeline.tokenizer(
    documents.map(() => query),
    { text_pair: documents, padding: true, truncation: true },
  );
  const outputs = await pipeline.model(modelInputs);
  const results = documents.map((text, index) => ({
    text,
    score: Number(outputs.logits[index]?.data?.[0] ?? Number.NEGATIVE_INFINITY),
  }));
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Standard reranker (bge-reranker-base, ~279MB) ──
export async function createStandardReranker(): Promise<RerankerProvider> {
  if (!standardPipeline) {
    standardPipeline = await loadRerankerPipeline("bge-reranker-base");
  }

  return {
    name: "bge-reranker-base",

    async rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>> {
      if (documents.length === 0) return [];
      if (!standardPipeline) throw new Error("Standard reranker not initialized");

      const start = Date.now();

      const results = await rerankDocumentsWithPipeline(standardPipeline, query, documents);

      console.log(`[Reranker] standard: ${documents.length} docs reranked in ${Date.now() - start}ms`);
      return results;
    },
  };
}

// ── Reranker manager ──
let currentReranker: RerankerProvider | null = null;
let currentRerankerMode: "standard" | "none" = "none";
let rerankerConfigVersion = 0;
let lazyInitPromise: Promise<RerankerProvider | null> | null = null;

function checkRerankerModelInstalled(): boolean {
  return getProjectModelBaseDir("reranker", "standard") !== null;
}

export function getRerankerInstallStatus(): { standard: boolean } {
  return { standard: checkRerankerModelInstalled() };
}

export async function initReranker(mode: "standard" | "none"): Promise<void> {
  const configVersion = ++rerankerConfigVersion;
  currentRerankerMode = mode;
  currentReranker = null;

  if (mode === "none") {
    currentReranker = null;
    console.log("[Reranker] disabled");
    return;
  }

  if (!checkRerankerModelInstalled()) {
    console.warn(`[Reranker] bge-reranker-base 未找到 (models/bge-reranker-base/onnx/model_quantized.onnx)，自动降级为 none。`);
    if (configVersion === rerankerConfigVersion) {
      currentRerankerMode = "none";
      currentReranker = null;
    }
    return;
  }

  console.log("[Reranker] initializing standard mode (bge-reranker-base)...");
  const reranker = await createStandardReranker();
  if (configVersion === rerankerConfigVersion) currentReranker = reranker;
  if (configVersion === rerankerConfigVersion && currentReranker) {
    console.log(`[Reranker] standard mode ready: ${currentReranker.name}`);
  }
}

export function configureRerankerForLazyInit(mode: "standard" | "none"): void {
  rerankerConfigVersion += 1;
  currentRerankerMode = mode;
  currentReranker = null;
  lazyInitPromise = null;
}

export async function ensureRerankerInitialized(): Promise<RerankerProvider | null> {
  if (currentReranker || currentRerankerMode === "none") return currentReranker;
  if (lazyInitPromise) return lazyInitPromise;
  const requestedMode = currentRerankerMode;
  const promise = initReranker(requestedMode)
    .then(() => currentRerankerMode === requestedMode ? currentReranker : null)
    .catch((error) => {
      console.warn(`[Reranker] lazy ${requestedMode} initialization failed; using hybrid ranking:`, error);
      return null;
    })
    .finally(() => { if (lazyInitPromise === promise) lazyInitPromise = null; });
  lazyInitPromise = promise;
  return promise;
}

export function getReranker(): RerankerProvider | null {
  return currentReranker;
}

export function getRerankerMode(): "standard" | "none" {
  return currentRerankerMode;
}

export function resetReranker(): void {
  rerankerConfigVersion += 1;
  currentReranker = null;
  currentRerankerMode = "none";
  lazyInitPromise = null;
  standardPipeline = null;
}
