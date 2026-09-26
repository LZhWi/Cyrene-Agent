import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("用法: node capture-n-memory-prompts.mjs <隔离评测目录>");
const corpus = JSON.parse(fs.readFileSync(path.join(outputDir, "corpus.json"), "utf8"));
const projectRoot = path.resolve(import.meta.dirname, "..", "..");
const sourcePath = path.join(projectRoot, "local-plugins", "plugins", "companion-memory", "src", "memory-extraction.ts");
const outputPath = path.join(outputDir, "n-prompts.json");
const bundlePath = path.join(outputDir, "n-extraction-builder.cjs");
if (fs.existsSync(outputPath) || fs.existsSync(bundlePath)) throw new Error("-N 提示词产物已存在，拒绝覆盖");
const require = createRequire(import.meta.url);
const esbuild = createRequire(path.join(projectRoot, "local-plugins", "package.json"))("esbuild");
esbuild.buildSync({ entryPoints: [sourcePath], bundle: true, platform: "node", format: "cjs", outfile: bundlePath });
const { buildMemoryExtractionMessages } = require(bundlePath);
const prompts = [];
for (const item of corpus.cases) for (const size of [8, 12]) {
  const turns = item.turns.slice(-size).map((turn, index) => ({
    id: turn.userMessageId, userAt: turn.userAt, assistantAt: turn.assistantAt,
    user: turn.user, assistant: turn.assistant, writable: index >= 2,
  }));
  const messages = buildMemoryExtractionMessages(turns, item.conversationId);
  prompts.push({ caseId: item.id, size, messages });
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
fs.writeFileSync(outputPath, JSON.stringify({ version: 1,
  sourceSha256: sha256(fs.readFileSync(sourcePath)), bundleSha256: sha256(fs.readFileSync(bundlePath)), prompts,
}, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ outputPath, prompts: prompts.length }));
