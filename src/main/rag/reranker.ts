// Reranker module — cross-encoder reranking for RAG
import * as path from "path";
import * as os from "os";
import { getAppRootDir } from "../runtime/runtime-paths";

// ── Types ──
export interface RerankerProvider {
  rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>>;
  readonly name: string;
}

// ── ESM import helper (same pattern as embedding.ts) ──
const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

// ── Pipeline cache ──
let lightPipeline: any = null;
let standardPipeline: any = null;

function getModelsDir(): string {
  return path.join(getAppRootDir(), "models");
}

async function loadRerankerPipeline(modelDir: string): Promise<any> {
  const { pipeline, env } = await importEsm("@xenova/transformers");

  // Save original localModelPath (embedding may have set it)
  const originalPath = env.localModelPath;
  // 主路径：项目根 models/。兜底：HF cache，通过 cache_dir 选项传给 pipeline。
  env.localModelPath = getModelsDir();
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
    // Restore so embedding pipeline still works
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
    // BGE/MS-MARCO reranker 是单 logit 回归模型；raw logit 的顺序即相关性顺序。
    score: Number(outputs.logits[index]?.data?.[0] ?? Number.NEGATIVE_INFINITY),
  }));
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── Lightweight reranker (ms-marco-MiniLM-L6-v2, ~23MB) ──
export async function createLightReranker(): Promise<RerankerProvider> {
  if (!lightPipeline) {
    lightPipeline = await loadRerankerPipeline("ms-marco-MiniLM-L-6-v2");
  }

  return {
    name: "ms-marco-MiniLM-L6-v2",

    async rerank(query: string, documents: string[]): Promise<Array<{ text: string; score: number }>> {
      if (documents.length === 0) return [];
      if (!lightPipeline) throw new Error("Light reranker not initialized");

      const start = Date.now();

      const results = await rerankDocumentsWithPipeline(lightPipeline, query, documents);

      console.log(`[Reranker] light: ${documents.length} docs reranked in ${Date.now() - start}ms`);
      return results;
    },
  };
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
let currentRerankerMode: "light" | "standard" | "none" = "none";

/**
 * 检查某个 rerank 模型的 onnx 文件是否存在于本地 models/ 目录。
 * models/.gitignore 排除了 *.onnx，所以新 clone 的仓库默认没有这些文件。
 */
function checkRerankerModelInstalled(mode: "light" | "standard"): boolean {
  const modelDir = mode === "light" ? "ms-marco-MiniLM-L-6-v2" : "bge-reranker-base";
  const onnxPath = path.join(getModelsDir(), modelDir, "onnx", "model_quantized.onnx");
  try {
    const fs = require("fs");
    return fs.existsSync(onnxPath);
  } catch {
    return false;
  }
}

/**
 * 返回所有 rerank 模型的安装状态，供 UI 真实渲染（不再硬编码"已安装"）。
 */
export function getRerankerInstallStatus(): { light: boolean; standard: boolean } {
  return {
    light: checkRerankerModelInstalled("light"),
    standard: checkRerankerModelInstalled("standard"),
  };
}

export async function initReranker(mode: "light" | "standard" | "none"): Promise<void> {
  currentRerankerMode = mode;

  if (mode === "none") {
    currentReranker = null;
    console.log("[Reranker] disabled");
    return;
  }

  // 入口 fallback：如果 onnx 文件不存在，自动降级为 none（不抛错，不让 RAG init FAILED）
  if (!checkRerankerModelInstalled(mode)) {
    const modelDir = mode === "light" ? "ms-marco-MiniLM-L-6-v2" : "bge-reranker-base";
    console.warn(`[Reranker] 模型未找到 (models/${modelDir}/onnx/model_quantized.onnx)，自动降级为 none。基础聊天和基础 RAG 不受影响。`);
    currentRerankerMode = "none";
    currentReranker = null;
    return;
  }

  console.log(`[Reranker] initializing ${mode} mode...`);

  if (mode === "light") {
    currentReranker = await createLightReranker();
  } else {
    currentReranker = await createStandardReranker();
  }

  console.log(`[Reranker] ${mode} mode ready: ${currentReranker.name}`);
}

export function getReranker(): RerankerProvider | null {
  return currentReranker;
}

export function getRerankerMode(): "light" | "standard" | "none" {
  return currentRerankerMode;
}

export function resetReranker(): void {
  currentReranker = null;
  currentRerankerMode = "none";
  lightPipeline = null;
  standardPipeline = null;
}
