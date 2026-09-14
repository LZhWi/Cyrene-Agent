import { createHash } from "node:crypto";
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
const inputArg = valueAfter("--input");
if (!inputArg) throw new Error("Usage: npm run eval:document-chunking -- --input <txt-or-md> [--model minilm|bgem3]");
const inputPath = path.resolve(inputArg);
const modelKey = valueAfter("--model") === "minilm" ? "minilm" : "bgem3";
if (!fs.statSync(inputPath).isFile()) throw new Error(`Document is not a file: ${inputPath}`);

const projectRoot = process.cwd();
const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-document-chunking-eval-"));
const importBuilt = (relativePath) => import(pathToFileURL(path.join(projectRoot, "dist", "main", relativePath)).href);
const digest = () => createHash("sha256").update(fs.readFileSync(inputPath)).digest("hex");
const before = digest();

try {
  const runtimePaths = await importBuilt(path.join("main", "runtime", "runtime-paths.js"));
  runtimePaths.setAppPathProvider({
    getPath(name) {
      if (name === "userData") return isolatedUserData;
      if (name === "temp") return os.tmpdir();
      if (name === "home") return os.homedir();
      return path.join(isolatedUserData, name);
    },
    getAppPath() { return projectRoot; },
  });
  const embedding = await importBuilt(path.join("main", "rag", "embedding.js"));
  const diagnostics = await importBuilt(path.join("main", "rag", "document-chunking-diagnostics.js"));
  const provider = embedding.createLocalEmbeddingProvider(modelKey);
  if (!provider) throw new Error(`Local embedding model is not installed: ${modelKey}`);
  const report = await diagnostics.evaluateDocumentChunkingSandbox({
    text: fs.readFileSync(inputPath, "utf8"),
    source: path.basename(inputPath),
    embedBatch: (texts) => provider.embedBatch(texts),
  });
  if (digest() !== before) throw new Error("Source document changed during isolated evaluation");
  console.table({
    sourceChars: report.sourceChars,
    sourceTokens: report.sourceTokens,
    baselineChunks: report.baseline.chunks,
    semanticChunks: report.semantic.chunks,
    semanticMinTokens: report.semantic.minTokens,
    semanticAverageTokens: Number(report.semantic.averageTokens.toFixed(1)),
    semanticMaxTokens: report.semantic.maxTokens,
    atomicUnits: report.semantic.atomicUnits,
    similarityComparisons: report.semantic.similarityComparisons,
    embeddingBatchCalls: report.semantic.embeddingBatchCalls,
    embeddingTexts: report.semantic.embeddingTexts,
    estimatedEmbeddingTokens: report.semantic.estimatedEmbeddingTokens,
    sourceHashUnchanged: report.sourceHashBefore === report.sourceHashAfter,
  });
} finally {
  fs.rmSync(isolatedUserData, { recursive: true, force: true });
}
