import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const [outputDir, runName] = process.argv.slice(2);
if (!outputDir || !/^[a-z0-9-]{3,80}$/.test(runName ?? "")) {
  throw new Error("用法: node replay-memory-extraction-ab.mjs <评测目录> <运行名>");
}
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const sourcePath = path.join(projectRoot, "local-plugins", "plugins", "companion-memory", "src", "memory-extraction.ts");
const runDir = path.join(outputDir, "runs", runName);
const resultPath = path.join(runDir, "post-fix-replay.json");
const bundlePath = path.join(runDir, "post-fix-extraction-builder.cjs");
if (fs.existsSync(resultPath) || fs.existsSync(bundlePath)) throw new Error("离线重放产物已存在，拒绝覆盖");
const require = createRequire(import.meta.url);
const esbuild = createRequire(path.join(projectRoot, "local-plugins", "package.json"))("esbuild");
esbuild.buildSync({ entryPoints: [sourcePath], bundle: true, platform: "node", format: "cjs", outfile: bundlePath });
const { parseMemoryExtraction } = require(bundlePath);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cases = ["conditional-plan", "project-commitment", "dated-travel"];
const results = [];
for (const caseId of cases) for (const size of [8, 12]) {
  const recordPath = path.join(runDir, `${caseId}-n-${size}.json`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  try {
    const candidates = parseMemoryExtraction(record.text, size);
    results.push({ caseId, size, sourceSha256: sha256(fs.readFileSync(recordPath)), acceptedCount: candidates.length });
  } catch (error) {
    results.push({ caseId, size, sourceSha256: sha256(fs.readFileSync(recordPath)), error: String(error) });
  }
}
const report = { version: 1, modelCalls: 0, parserSourceSha256: sha256(fs.readFileSync(sourcePath)),
  parserBundleSha256: sha256(fs.readFileSync(bundlePath)), results };
fs.writeFileSync(resultPath, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ resultPath, modelCalls: 0, results }));
