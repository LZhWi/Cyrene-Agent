import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const normalizeCliValue = (value) => value?.replace(/^\^/, "").replace(/\^$/, "").replace(/\^(?=\s)/g, "");
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? normalizeCliValue(args[index + 1]) : undefined;
};
const valuesAfter = (flag) => args.flatMap((value, index) => value === flag && args[index + 1]
  ? [normalizeCliValue(args[index + 1])]
  : []);

const inputArg = valueAfter("--input");
const outputArg = valueAfter("--output");
if (!inputArg || !outputArg) {
  throw new Error("Usage: npm run transcribe:local-audio -- --input <audio> --output <transcript.md|txt|docx> [--format md|txt|docx] [--no-timestamps] [--profile qwen17-stream|qwen06-stream] [--language zh|en|auto] [--hotword word]");
}

const projectRoot = process.cwd();
const profile = valueAfter("--profile") ?? "qwen17-stream";
const language = valueAfter("--language") ?? "zh";
const outputExtension = path.extname(outputArg).slice(1).toLowerCase();
const format = valueAfter("--format") ?? (["md", "txt", "docx"].includes(outputExtension) ? outputExtension : "md");
if (!["qwen17-stream", "qwen06-stream"].includes(profile)) throw new Error(`离线转写不支持 ASR 方案：${profile}`);
if (!["zh", "en", "auto"].includes(language)) throw new Error(`不支持的语言：${language}`);
if (!["md", "txt", "docx"].includes(format)) throw new Error(`不支持的输出格式：${format}`);
const { transcribeLocalAudioFile } = await import(pathToFileURL(
  path.join(projectRoot, "dist", "main", "main", "asr", "offline-transcription.js"),
).href);

const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || projectRoot, "AppData", "Roaming");
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const result = await transcribeLocalAudioFile({
  inputPath: path.resolve(inputArg),
  outputPath: path.resolve(outputArg),
  appRoot: projectRoot,
  userDataPath: path.join(appData, "live2d-cyrene"),
  profile,
  language,
  hotwords: valuesAfter("--hotword").map((value) => value.trim()).filter(Boolean).slice(0, 200),
  format,
  includeTimestamps: !args.includes("--no-timestamps"),
  overwrite: args.includes("--force"),
  signal: controller.signal,
  onProgress: (progress) => {
    const fraction = progress.totalSegments ? ` (${progress.completedSegments ?? 0}/${progress.totalSegments})` : "";
    process.stdout.write(`[ASR] ${progress.message}${fraction}\n`);
  },
});
process.stdout.write(`转写完成：${result.outputPath}\n`);
