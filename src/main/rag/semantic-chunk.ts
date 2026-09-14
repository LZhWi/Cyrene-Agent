import { estimateTokens, type Chunk } from "./chunk";

export const SEMANTIC_ATOMIC_TARGET = 80;
export const SEMANTIC_CHUNK_MIN = 128;
export const SEMANTIC_CHUNK_TARGET = 384;
export const SEMANTIC_CHUNK_MAX = 512;
export const SEMANTIC_ADJACENT_THRESHOLD = 0.55;
export const SEMANTIC_CENTROID_THRESHOLD = 0.5;
export const SEMANTIC_EMBED_BATCH_SIZE = 32;

export interface SemanticDocumentUnit {
  text: string;
  start: number;
  end: number;
  tokens: number;
  hardBoundaryBefore: boolean;
  headingPath: string[];
}

export interface SemanticPreparedChunk extends Chunk {
  embedding: number[];
}

export interface SemanticChunkingOptions {
  atomicTarget?: number;
  minTokens?: number;
  targetTokens?: number;
  maxTokens?: number;
  adjacentThreshold?: number;
  centroidThreshold?: number;
  embeddingBatchSize?: number;
  isCancelled?: () => boolean;
  onProgress?: (progress: {
    phase: "semantic-boundaries" | "chunk-embeddings";
    completed: number;
    total: number;
  }) => void;
}

export interface SemanticChunkingResult {
  chunks: SemanticPreparedChunk[];
  atomicUnitCount: number;
  similarityComparisons: number;
  embeddingTexts: number;
  estimatedEmbeddingTokens: number;
}

interface RawSpan {
  text: string;
  start: number;
  end: number;
  hardBoundaryBefore: boolean;
  headingPath: string[];
}

function splitLineAtSentences(line: string, lineStart: number, headingPath: string[]): RawSpan[] {
  const spans: RawSpan[] = [];
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    const current = line[index];
    const periodBoundary = current === "."
      && !(/\d/u.test(line[index - 1] ?? "") && /\d/u.test(line[index + 1] ?? ""))
      && (index + 1 === line.length || /\s/u.test(line[index + 1]));
    if (!"。！？!?…".includes(current) && !periodBoundary) continue;
    while (index + 1 < line.length && "。！？!?…".includes(line[index + 1])) index += 1;
    const end = index + 1;
    const text = line.slice(start, end).trim();
    if (text) {
      const leading = line.slice(start, end).search(/\S/u);
      const absoluteStart = lineStart + start + Math.max(leading, 0);
      spans.push({ text, start: absoluteStart, end: absoluteStart + text.length, hardBoundaryBefore: false, headingPath: [...headingPath] });
    }
    start = end;
  }
  const tail = line.slice(start).trim();
  if (tail) {
    const leading = line.slice(start).search(/\S/u);
    const absoluteStart = lineStart + start + Math.max(leading, 0);
    spans.push({ text: tail, start: absoluteStart, end: absoluteStart + tail.length, hardBoundaryBefore: false, headingPath: [...headingPath] });
  }
  return spans;
}

function splitOversizedSpan(span: RawSpan, maxTokens: number): RawSpan[] {
  if (estimateTokens(span.text) <= maxTokens) return [span];
  const totalTokens = Math.max(1, estimateTokens(span.text));
  const charsPerPart = Math.max(1, Math.floor(span.text.length * maxTokens / totalTokens));
  const parts: RawSpan[] = [];
  for (let offset = 0; offset < span.text.length; offset += charsPerPart) {
    const text = span.text.slice(offset, offset + charsPerPart).trim();
    if (!text) continue;
    const relativeStart = span.text.indexOf(text, offset);
    parts.push({
      text,
      start: span.start + relativeStart,
      end: span.start + relativeStart + text.length,
      hardBoundaryBefore: parts.length === 0 ? span.hardBoundaryBefore : false,
      headingPath: [...span.headingPath],
    });
  }
  return parts;
}

function rawDocumentSpans(text: string, atomicTarget: number): RawSpan[] {
  const spans: RawSpan[] = [];
  const headings: Array<{ level: number; title: string }> = [];
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  let offset = 0;
  let inFence = false;
  let fenceStart = 0;
  let fenceText = "";
  let fenceHeadingPath: string[] = [];

  for (const rawLine of lines) {
    if (!rawLine) continue;
    const line = rawLine.replace(/\n$/, "").replace(/\r$/, "");
    const trimmed = line.trim();
    const isFence = /^\s*```/.test(line);
    if (inFence) {
      fenceText += rawLine;
      if (isFence) {
        spans.push(...splitOversizedSpan({
          text: fenceText.trim(), start: fenceStart, end: offset + rawLine.length,
          hardBoundaryBefore: true, headingPath: fenceHeadingPath,
        }, atomicTarget));
        inFence = false;
        fenceText = "";
      }
      offset += rawLine.length;
      continue;
    }
    if (isFence) {
      inFence = true;
      fenceStart = offset;
      fenceText = rawLine;
      fenceHeadingPath = headings.map((heading) => heading.title);
      offset += rawLine.length;
      continue;
    }
    if (!trimmed) {
      offset += rawLine.length;
      continue;
    }
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      while (headings.length > 0 && headings.at(-1)!.level >= level) headings.pop();
      headings.push({ level, title: headingMatch[2].trim() });
      const start = offset + line.search(/\S/u);
      spans.push({
        text: trimmed, start, end: start + trimmed.length,
        hardBoundaryBefore: true, headingPath: headings.map((heading) => heading.title),
      });
    } else {
      const headingPath = headings.map((heading) => heading.title);
      const lineSpans = splitLineAtSentences(line, offset, headingPath);
      for (const span of lineSpans) {
        spans.push(...splitOversizedSpan(span, atomicTarget));
      }
    }
    offset += rawLine.length;
  }
  if (inFence && fenceText.trim()) {
    spans.push(...splitOversizedSpan({
      text: fenceText.trim(), start: fenceStart, end: text.length,
      hardBoundaryBefore: true, headingPath: fenceHeadingPath,
    }, atomicTarget));
  }
  return spans;
}

export function createSemanticDocumentUnits(
  text: string,
  atomicTarget = SEMANTIC_ATOMIC_TARGET,
): SemanticDocumentUnit[] {
  const raw = rawDocumentSpans(text, Math.max(16, atomicTarget));
  const units: SemanticDocumentUnit[] = [];
  let pending: RawSpan[] = [];
  let pendingTokens = 0;
  const flush = () => {
    if (pending.length === 0) return;
    const start = pending[0].start;
    const end = pending.at(-1)!.end;
    const unitText = text.slice(start, end).trim();
    units.push({
      text: unitText,
      start,
      end,
      tokens: estimateTokens(unitText),
      hardBoundaryBefore: pending[0].hardBoundaryBefore,
      headingPath: [...pending[0].headingPath],
    });
    pending = [];
    pendingTokens = 0;
  };
  for (const span of raw) {
    if (span.hardBoundaryBefore && pending.length > 0) flush();
    pending.push(span);
    pendingTokens += estimateTokens(span.text);
    if (pendingTokens >= atomicTarget) flush();
  }
  flush();
  return units;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

function weightedCentroid(vectors: number[][], weights: number[]): number[] {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  return vectors[0].map((_, dimension) => (
    vectors.reduce((sum, vector, index) => sum + vector[dimension] * weights[index], 0) / totalWeight
  ));
}

async function embedInBatches(
  texts: string[],
  embedBatch: (texts: string[]) => Promise<number[][]>,
  batchSize: number,
  phase: "semantic-boundaries" | "chunk-embeddings",
  options: SemanticChunkingOptions,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += batchSize) {
    if (options.isCancelled?.()) throw new Error("cancelled");
    const batch = texts.slice(start, start + batchSize);
    const embedded = await embedBatch(batch);
    if (embedded.length !== batch.length) throw new Error("Embedding provider returned an unexpected batch size");
    vectors.push(...embedded);
    options.onProgress?.({ phase, completed: vectors.length, total: texts.length });
  }
  return vectors;
}

export async function createSemanticDocumentChunks(
  text: string,
  source: string,
  embedBatch: (texts: string[]) => Promise<number[][]>,
  options: SemanticChunkingOptions = {},
): Promise<SemanticChunkingResult> {
  const minTokens = options.minTokens ?? SEMANTIC_CHUNK_MIN;
  const targetTokens = options.targetTokens ?? SEMANTIC_CHUNK_TARGET;
  const maxTokens = Math.max(targetTokens, options.maxTokens ?? SEMANTIC_CHUNK_MAX);
  const units = createSemanticDocumentUnits(
    text,
    Math.min(options.atomicTarget ?? SEMANTIC_ATOMIC_TARGET, maxTokens),
  );
  if (units.length === 0) return { chunks: [], atomicUnitCount: 0, similarityComparisons: 0, embeddingTexts: 0, estimatedEmbeddingTokens: 0 };
  const batchSize = Math.max(1, options.embeddingBatchSize ?? SEMANTIC_EMBED_BATCH_SIZE);
  const unitVectors = await embedInBatches(units.map((unit) => unit.text), embedBatch, batchSize, "semantic-boundaries", options);
  const groups: SemanticDocumentUnit[][] = [];
  let currentUnits: SemanticDocumentUnit[] = [];
  let currentVectors: number[][] = [];
  let currentTokens = 0;
  let comparisons = 0;
  const flush = () => {
    if (currentUnits.length > 0) groups.push(currentUnits);
    currentUnits = [];
    currentVectors = [];
    currentTokens = 0;
  };

  units.forEach((unit, index) => {
    if (currentUnits.length === 0) {
      currentUnits = [unit];
      currentVectors = [unitVectors[index]];
      currentTokens = unit.tokens;
      return;
    }
    const exceedsMax = currentTokens + unit.tokens > maxTokens;
    const crossesStructure = unit.hardBoundaryBefore && currentTokens >= minTokens;
    let semanticallyClose = false;
    if (!exceedsMax && !crossesStructure) {
      comparisons += 1;
      const adjacent = cosineSimilarity(currentVectors.at(-1)!, unitVectors[index]);
      const centroid = weightedCentroid(currentVectors, currentUnits.map((item) => item.tokens));
      const targetBonus = currentTokens >= targetTokens ? 0.08 : 0;
      semanticallyClose = adjacent >= (options.adjacentThreshold ?? SEMANTIC_ADJACENT_THRESHOLD) + targetBonus
        && cosineSimilarity(centroid, unitVectors[index]) >= (options.centroidThreshold ?? SEMANTIC_CENTROID_THRESHOLD) + targetBonus;
    }
    if (!exceedsMax && !crossesStructure && (currentTokens < minTokens || semanticallyClose)) {
      currentUnits.push(unit);
      currentVectors.push(unitVectors[index]);
      currentTokens += unit.tokens;
    } else {
      flush();
      currentUnits = [unit];
      currentVectors = [unitVectors[index]];
      currentTokens = unit.tokens;
    }
  });
  flush();

  const chunkTexts = groups.map((group) => {
    const first = group[0];
    const content = text.slice(first.start, group.at(-1)!.end).trim();
    const prefix = first.headingPath.join(" > ");
    return prefix && !/^#{1,6}\s/u.test(content) ? `【${prefix}】${content}` : content;
  });
  const chunkVectors = await embedInBatches(chunkTexts, embedBatch, batchSize, "chunk-embeddings", options);
  return {
    chunks: chunkTexts.map((chunkText, index) => ({
      id: `${source}_${index}`,
      text: chunkText,
      source,
      index,
      embedding: chunkVectors[index],
    })),
    atomicUnitCount: units.length,
    similarityComparisons: comparisons,
    embeddingTexts: units.length + chunkTexts.length,
    estimatedEmbeddingTokens: units.reduce((sum, unit) => sum + unit.tokens, 0)
      + chunkTexts.reduce((sum, chunkText) => sum + estimateTokens(chunkText), 0),
  };
}
