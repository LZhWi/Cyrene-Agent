import { createHash } from "node:crypto";
import { chunkText, estimateTokens } from "./chunk";
import {
  createSemanticDocumentChunks,
  type SemanticChunkingOptions,
} from "./semantic-chunk";

export interface DocumentChunkingSandboxReport {
  version: 1;
  actualDataUnchanged: true;
  sourceHashBefore: string;
  sourceHashAfter: string;
  sourceChars: number;
  sourceTokens: number;
  baseline: DocumentChunkingVariantMetrics;
  semantic: DocumentChunkingVariantMetrics & {
    atomicUnits: number;
    similarityComparisons: number;
    embeddingBatchCalls: number;
    embeddingTexts: number;
    estimatedEmbeddingTokens: number;
  };
}

export interface DocumentChunkingVariantMetrics {
  chunks: number;
  minTokens: number;
  maxTokens: number;
  averageTokens: number;
  chunkHashes: string[];
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function metrics(chunks: Array<{ text: string }>): DocumentChunkingVariantMetrics {
  const sizes = chunks.map((chunk) => estimateTokens(chunk.text));
  return {
    chunks: chunks.length,
    minTokens: sizes.length > 0 ? Math.min(...sizes) : 0,
    maxTokens: sizes.length > 0 ? Math.max(...sizes) : 0,
    averageTokens: sizes.length > 0 ? sizes.reduce((sum, size) => sum + size, 0) / sizes.length : 0,
    chunkHashes: chunks.map((chunk) => digest(chunk.text).slice(0, 12)),
  };
}

/**
 * Pure isolated evaluator: callers supply document text and an embedding function.
 * It never resolves userData paths and never writes files or RAG state.
 */
export async function evaluateDocumentChunkingSandbox(input: {
  text: string;
  source?: string;
  embedBatch: (texts: string[]) => Promise<number[][]>;
  options?: SemanticChunkingOptions;
}): Promise<DocumentChunkingSandboxReport> {
  const sourceHashBefore = digest(input.text);
  let embeddingBatchCalls = 0;
  const semantic = await createSemanticDocumentChunks(
    input.text,
    input.source ?? "sandbox-document",
    async (texts) => {
      embeddingBatchCalls += 1;
      return input.embedBatch(texts);
    },
    input.options,
  );
  const sourceHashAfter = digest(input.text);
  if (sourceHashAfter !== sourceHashBefore) throw new Error("Document chunking sandbox mutated its source text");
  return {
    version: 1,
    actualDataUnchanged: true,
    sourceHashBefore,
    sourceHashAfter,
    sourceChars: input.text.length,
    sourceTokens: estimateTokens(input.text),
    baseline: metrics(chunkText(input.text, input.source ?? "sandbox-document")),
    semantic: {
      ...metrics(semantic.chunks),
      atomicUnits: semantic.atomicUnitCount,
      similarityComparisons: semantic.similarityComparisons,
      embeddingBatchCalls,
      embeddingTexts: semantic.embeddingTexts,
      estimatedEmbeddingTokens: semantic.estimatedEmbeddingTokens,
    },
  };
}
