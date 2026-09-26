import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [outputDir, runName] = process.argv.slice(2);
if (!outputDir || !runName) throw new Error("用法: node summarize-memory-extraction-ab.mjs <评测目录> <运行名>");
const runDir = path.join(outputDir, "runs", runName);
const corpus = JSON.parse(fs.readFileSync(path.join(outputDir, "corpus.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
const localParsed = JSON.parse(fs.readFileSync(path.join(runDir, "local-parsed.json"), "utf8"));
const require = createRequire(import.meta.url);
const { parseMemoryExtraction } = require(path.join(outputDir, "n-extraction-builder.cjs"));
const results = [];
for (const key of manifest.order) {
  const [caseId, variant, rawSize] = key.split("/");
  const item = corpus.cases.find((value) => value.id === caseId);
  const size = Number(rawSize);
  if (!item || !["local", "n"].includes(variant) || ![8, 12].includes(size)) throw new Error(`无效实验单元: ${key}`);
  const record = JSON.parse(fs.readFileSync(path.join(runDir, `${item.id}-${variant}-${size}.json`), "utf8"));
  const window = item.turns.slice(-size);
  let candidates = [], parseError;
  if (variant === "local") {
    const parsed = localParsed.results.find((value) => value.caseId === item.id && value.size === size);
    if (!parsed) throw new Error(`缺少本地解析: ${item.id}/${size}`);
    candidates = parsed.candidates ?? [];
    parseError = parsed.error;
  } else {
    try { candidates = parseMemoryExtraction(record.text, size); }
    catch (error) { parseError = String(error); }
  }
  const checked = candidates.map((candidate) => {
    const refs = candidate.evidenceTurnRefs ?? [];
    const cited = refs.flatMap((ref) => {
      const index = Number(/^T(\d+)$/.exec(ref)?.[1] ?? 0) - 1;
      return index >= 0 && index < window.length ? [{ index, turn: window[index] }] : [];
    });
    const quotes = candidate.evidenceQuotes ?? [];
    return { summary: candidate.summary ?? candidate.content, layer: candidate.layer, refs,
      evidenceQuotes: quotes, sourceValid: cited.length > 0 && refs.length === cited.length,
      quoteValid: quotes.length > 0 && quotes.every((quote) => cited.some(({ turn }) => turn.user.includes(quote))),
      nReadOnlyOnly: variant === "n" && cited.length > 0 && cited.every(({ index }) => index < 2) };
  });
  results.push({ caseId: item.id, size, variant,
    production: variant === "local" ? size === 8 : size === 12,
    latencyMs: record.latencyMs, usage: record.usage, rawChars: record.text.length,
    acceptedCount: checked.length, validEvidenceCount: checked.filter((candidate) => candidate.sourceValid && candidate.quoteValid).length,
    unsupportedCount: checked.filter((candidate) => !candidate.sourceValid || !candidate.quoteValid).length,
    nReadOnlyOnlyCount: checked.filter((candidate) => candidate.nReadOnlyOnly).length,
    ...(parseError ? { parseError } : {}), candidates: checked });
}
const summary = { version: 1, runName, sourceSha256: corpus.sourceSha256, results,
  totals: { calls: results.length, inputTokens: results.reduce((sum, result) => sum + (result.usage?.input ?? 0), 0),
    outputTokens: results.reduce((sum, result) => sum + (result.usage?.output ?? 0), 0) } };
const outputPath = path.join(runDir, "summary.json");
fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ outputPath, totals: summary.totals,
  cells: results.map(({ caseId, size, variant, production, acceptedCount, validEvidenceCount, unsupportedCount, parseError }) =>
    ({ caseId, size, variant, production, acceptedCount, validEvidenceCount, unsupportedCount, parseError })) }));
