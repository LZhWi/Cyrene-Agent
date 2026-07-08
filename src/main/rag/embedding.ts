// @xenova/transformers is ESM-only, use dynamic import in CJS context
import { checkEmbeddingModelInstalled } from "./model-status";

// ── 类型 ──
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dims: number;
  readonly name: string;
}

// ── 模型注册表 ──
interface ModelConfig {
  key: string;
  hfName: string;
  dims: number;
}

const LOCAL_MODELS: Record<string, ModelConfig> = {
  minilm: { key: "minilm", hfName: "Xenova/all-MiniLM-L6-v2", dims: 384 },
  bgem3:  { key: "bgem3",  hfName: "Xenova/bge-m3",          dims: 1024 },
};

const DEFAULT_MODEL_KEY = "minilm";

// ── 本地 Pipeline ──
// 每个模型 key 独立缓存 pipeline，支持多模型同时运行（minilm 管文档/记忆，bgem3 管场景识别）
const localPipelines: Map<string, any> = new Map();
let currentModelKey: string = DEFAULT_MODEL_KEY;

const importEsm = new Function("moduleName", "return import(moduleName)") as (moduleName: string) => Promise<any>;

async function getLocalPipeline(modelKey?: string): Promise<any> {
  const key = modelKey || currentModelKey;
  const config = LOCAL_MODELS[key];
  if (!config) throw new Error("Unknown embedding model: " + key);

  let pipe = localPipelines.get(key);
  if (!pipe) {
    const { pipeline, env } = await importEsm("@xenova/transformers");
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useBrowserCache = false;
    env.localModelPath = require("path").join(require("os").homedir(), ".cache", "huggingface");
    pipe = await pipeline("feature-extraction", config.hfName);
    localPipelines.set(key, pipe);
  }
  return pipe;
}

export function createLocalEmbeddingProvider(modelKey?: string): EmbeddingProvider | null {
  const key = modelKey || DEFAULT_MODEL_KEY;
  const config = LOCAL_MODELS[key];
  if (!config) throw new Error("Unknown embedding model: " + key);

  // 模型缺失返回 null，调用方决定如何处理
  if (!checkEmbeddingModelInstalled(key)) {
    return null;
  }

  return {
    name: "local-" + config.hfName.split("/").pop(),
    dims: config.dims,

    async embed(text: string): Promise<number[]> {
      const pipe = await getLocalPipeline(key);
      const result: any = await pipe(text, { pooling: "mean", normalize: true });
      return Array.from(result.data as Float32Array);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const pipe = await getLocalPipeline(key);
      const results: number[][] = [];
      for (const text of texts) {
        const result: any = await pipe(text, { pooling: "mean", normalize: true });
        results.push(Array.from(result.data as Float32Array));
      }
      return results;
    },
  };
}

// ── OpenAI 兼容 Provider ──
export function createOpenAIEmbeddingProvider(
  baseUrl: string,
  apiKey: string,
  model = "text-embedding-ada-002"
): EmbeddingProvider {
  const endpoint = baseUrl.replace(/\/+$/, "") + "/embeddings";

  return {
    name: "openai-compat-" + model,
    dims: 1536,

    async embed(text: string): Promise<number[]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) {
        throw new Error("Embedding API error: " + res.status + " " + await res.text());
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      return data.data[0].embedding;
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        throw new Error("Embedding API error: " + res.status + " " + await res.text());
      }
      const data = await res.json() as { data: Array<{ embedding: number[] }> };
      return data.data.map((d) => d.embedding);
    },
  };
}

// ── 自动选择 Provider ──
let cachedProvider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(
  mode: "auto" | "local" | "cloud" = "auto",
  cloudBaseUrl?: string,
  cloudApiKey?: string,
  modelKey?: string
): EmbeddingProvider | null {
  if (cachedProvider) return cachedProvider;

  if (mode === "local") {
    cachedProvider = createLocalEmbeddingProvider(modelKey);
  } else if (mode === "cloud" && cloudBaseUrl && cloudApiKey) {
    cachedProvider = createOpenAIEmbeddingProvider(cloudBaseUrl, cloudApiKey);
  } else {
    // auto 模式：优先 local，local 不存在且 cloud 配置完整时用 cloud，否则 null
    const local = createLocalEmbeddingProvider(modelKey);
    if (local) {
      cachedProvider = local;
    } else if (cloudBaseUrl && cloudApiKey) {
      cachedProvider = createOpenAIEmbeddingProvider(cloudBaseUrl, cloudApiKey);
    } else {
      cachedProvider = null;
    }
  }

  return cachedProvider;
}

export function getCurrentModelKey(): string {
  return currentModelKey;
}

export function getCurrentModelDims(): number {
  const config = LOCAL_MODELS[currentModelKey];
  return config ? config.dims : 384;
}

export function switchEmbeddingModel(modelKey: string): void {
  const config = LOCAL_MODELS[modelKey];
  if (!config) throw new Error("Unknown embedding model: " + modelKey);
  cachedProvider = null;
  localPipelines.delete(currentModelKey);
  currentModelKey = modelKey;
}

export function resetEmbeddingProvider(): void {
  cachedProvider = null;
  localPipelines.clear();
  currentModelKey = DEFAULT_MODEL_KEY;
}

// ── 场景识别专用 provider（固定 bge-m3，不受 RAG 模型切换影响）──
let sceneProvider: EmbeddingProvider | null = null;

/**
 * 获取场景识别专用的 embedding provider（固定 bge-m3）。
 * 和文档/记忆的 provider 独立——RAG 切换模型不影响场景识别。
 * 模型不存在时返回 null。
 */
export function getSceneEmbeddingProvider(): EmbeddingProvider | null {
  if (!sceneProvider) {
    sceneProvider = createLocalEmbeddingProvider("bgem3");
  }
  return sceneProvider;
}

export { checkEmbeddingModelInstalled };
