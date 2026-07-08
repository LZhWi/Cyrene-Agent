// Model installation status detection
// Provides unified model availability checks for embedding and reranker models.

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const HF_CACHE_DIR = path.join(os.homedir(), ".cache", "huggingface", "Xenova");

export interface ModelInstallStatus {
  embedding: { minilm: boolean; bgem3: boolean };
  reranker: { light: boolean; standard: boolean };
}

// All models require these files to be considered "installed"
const REQUIRED_FILES = ["tokenizer.json", "config.json", "onnx/model_quantized.onnx"];

// Possible sub-paths for each model (for compatibility with different organization styles)
const MODEL_SUB_PATHS: Record<string, string[]> = {
  "embedding-minilm": ["all-MiniLM-L6-v2", "Xenova/all-MiniLM-L6-v2"],
  "embedding-bgem3": ["bge-m3", "Xenova/bge-m3"],
  "reranker-light": ["ms-marco-MiniLM-L-6-v2"],
  "reranker-standard": ["bge-reranker-base"],
};

function checkModelFiles(modelId: string, baseDir: string): boolean {
  const subPaths = MODEL_SUB_PATHS[modelId];
  if (!subPaths) return false;

  for (const subPath of subPaths) {
    const modelDir = path.join(baseDir, subPath);
    if (REQUIRED_FILES.every((file) => fs.existsSync(path.join(modelDir, file)))) {
      return true;
    }
  }
  return false;
}

/**
 * Get the project models directory.
 * Priority: CYRENE_MODELS_DIR > process.resourcesPath > source root models/
 */
export function getProjectModelsDir(): string {
  if (process.env.CYRENE_MODELS_DIR) {
    return process.env.CYRENE_MODELS_DIR;
  }
  if (process.resourcesPath) {
    return path.join(process.resourcesPath, "models");
  }
  // Development: source root models/
  return path.join(__dirname, "..", "..", "..", "models");
}

export function getModelInstallStatus(): ModelInstallStatus {
  const projectDir = getProjectModelsDir();
  return {
    embedding: {
      minilm:
        checkModelFiles("embedding-minilm", projectDir) ||
        checkModelFiles("embedding-minilm", HF_CACHE_DIR),
      bgem3:
        checkModelFiles("embedding-bgem3", projectDir) ||
        checkModelFiles("embedding-bgem3", HF_CACHE_DIR),
    },
    reranker: {
      light: checkModelFiles("reranker-light", projectDir),
      standard: checkModelFiles("reranker-standard", projectDir),
    },
  };
}

export function checkEmbeddingModelInstalled(modelKey: string): boolean {
  const id = modelKey === "bgem3" ? "embedding-bgem3" : "embedding-minilm";
  const projectDir = getProjectModelsDir();
  return checkModelFiles(id, projectDir) || checkModelFiles(id, HF_CACHE_DIR);
}

export function checkRerankerModelInstalled(modelId: "light" | "standard"): boolean {
  const id = modelId === "light" ? "reranker-light" : "reranker-standard";
  return checkModelFiles(id, getProjectModelsDir());
}
