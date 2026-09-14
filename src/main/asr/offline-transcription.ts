import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import { formatAudioTimestamp, segmentPcmBySilence } from "./offline-audio";

export type OfflineTranscriptionProfile = "qwen17-stream" | "qwen06-stream";
export type OfflineTranscriptionFormat = "md" | "txt" | "docx";
export type OfflineTranscriptionPhase = "decoding" | "segmenting" | "loading" | "transcribing";

export interface OfflineTranscriptionProgress {
  phase: OfflineTranscriptionPhase;
  message: string;
  completedSegments?: number;
  totalSegments?: number;
}

export interface OfflineTranscriptionOptions {
  inputPath: string;
  outputPath: string;
  appRoot: string;
  userDataPath: string;
  profile: OfflineTranscriptionProfile;
  language: "zh" | "en" | "auto";
  hotwords: string[];
  format?: OfflineTranscriptionFormat;
  includeTimestamps?: boolean;
  overwrite?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: OfflineTranscriptionProgress) => void;
}

export interface OfflineTranscriptionResult {
  outputPath: string;
  durationSeconds: number;
  segmentCount: number;
}

interface WorkerEvent {
  type?: string;
  sessionId?: string;
  text?: string;
  message?: string;
  phase?: string;
  model?: string;
}

export interface TranscriptMetadata {
  title: string;
  sourceName: string;
  sourceHash: string;
  profile: OfflineTranscriptionProfile;
  language: "zh" | "en" | "auto";
  duration: string;
}

export interface TranscriptSegment {
  start: string;
  end: string;
  text: string;
}

function metadataLines(metadata: TranscriptMetadata): string[] {
  return [
    `来源文件：${metadata.sourceName}`,
    `来源 SHA-256：${metadata.sourceHash}`,
    `本地 ASR：${metadata.profile}`,
    `语言：${metadata.language}`,
    `音频时长：${metadata.duration}`,
  ];
}

export function formatTranscriptSegment(
  format: Exclude<OfflineTranscriptionFormat, "docx">,
  segment: TranscriptSegment,
  includeTimestamps: boolean,
): string {
  if (!includeTimestamps) return `${segment.text}\n\n`;
  return format === "md"
    ? `## ${segment.start}–${segment.end}\n\n${segment.text}\n\n`
    : `[${segment.start}–${segment.end}]\n${segment.text}\n\n`;
}

function transcriptHeader(format: Exclude<OfflineTranscriptionFormat, "docx">, metadata: TranscriptMetadata): string {
  if (format === "md") return [`# ${metadata.title}`, "", ...metadataLines(metadata).map((line) => `- ${line}`), ""].join("\n");
  return [metadata.title, "", ...metadataLines(metadata), ""].join("\n");
}

export async function createTranscriptDocx(
  metadata: TranscriptMetadata,
  segments: TranscriptSegment[],
  includeTimestamps: boolean,
): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: metadata.title, heading: HeadingLevel.TITLE }),
    ...metadataLines(metadata).map((line) => new Paragraph({ text: line })),
  ];
  for (const segment of segments) {
    if (includeTimestamps) children.push(new Paragraph({ text: `${segment.start}–${segment.end}`, heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: segment.text, spacing: { after: 180 } }));
  }
  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}

function abortError(): Error {
  const error = new Error("转写已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function findPythonExecutable(appRoot: string): string {
  const override = process.env.CYRENE_ASR_PYTHON?.trim();
  if (override) return override;
  const candidates = process.platform === "win32"
    ? [path.join(appRoot, ".venv-asr", "Scripts", "python.exe"), path.join(process.cwd(), ".venv-asr", "Scripts", "python.exe")]
    : [path.join(appRoot, ".venv-asr", "bin", "python"), path.join(process.cwd(), ".venv-asr", "bin", "python")];
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error("本地 ASR 环境尚未安装，请先运行 scripts/setup-local-asr.ps1");
  return executable;
}

function runProcess(executable: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("exit", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(abortError());
      else if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${path.basename(executable)} 退出，code=${code}`));
    });
  });
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

class OfflineAsrWorker {
  private readonly waiters: Array<{
    match: (event: WorkerEvent) => boolean;
    resolve: (event: WorkerEvent) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = [];

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onStatus: (event: WorkerEvent) => void,
  ) {
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) console.log("[OfflineASR]", line);
    });
    child.on("exit", (code) => this.rejectAll(new Error(`本地 ASR worker 已退出，code=${code ?? "null"}`)));
    child.on("error", (error) => this.rejectAll(error));
  }

  private handleLine(line: string): void {
    let event: WorkerEvent;
    try { event = JSON.parse(line) as WorkerEvent; } catch { return; }
    if (event.type === "status") this.onStatus(event);
    const index = this.waiters.findIndex((waiter) => waiter.match(event));
    if (index < 0) return;
    const [waiter] = this.waiters.splice(index, 1);
    clearTimeout(waiter.timeout);
    if (event.type === "error") waiter.reject(new Error(event.message || "本地 ASR 失败"));
    else waiter.resolve(event);
  }

  private waitFor(match: (event: WorkerEvent) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<WorkerEvent> {
    return new Promise((resolve, reject) => {
      throwIfAborted(signal);
      const waiter = {
        match,
        resolve: (event: WorkerEvent) => { signal?.removeEventListener("abort", abort); resolve(event); },
        reject: (error: Error) => { signal?.removeEventListener("abort", abort); reject(error); },
        timeout: undefined as unknown as NodeJS.Timeout,
      };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        clearTimeout(waiter.timeout);
        reject(abortError());
      };
      waiter.timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(new Error("等待本地 ASR 响应超时"));
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private send(command: unknown): void {
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private rejectAll(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }

  async configure(profile: OfflineTranscriptionProfile, language: string, hotwords: string[], signal?: AbortSignal): Promise<void> {
    const response = this.waitFor((event) => event.type === "ready" || (event.type === "error" && !event.sessionId), 60 * 60_000, signal);
    this.send({ type: "configure", profile, language, hotwords });
    await response;
  }

  async transcribe(pcm: Buffer, index: number, signal?: AbortSignal): Promise<string> {
    const sessionId = `offline-${index}-${randomUUID()}`;
    const response = this.waitFor(
      (event) => event.sessionId === sessionId && (event.type === "final" || event.type === "error"),
      10 * 60_000,
      signal,
    );
    this.send({ type: "start", sessionId, emitPartials: false });
    this.send({ type: "audio", sessionId, pcm: pcm.toString("base64") });
    this.send({ type: "finish", sessionId });
    return String((await response).text ?? "").trim();
  }

  stop(): void {
    if (this.child.killed) return;
    try { this.send({ type: "shutdown" }); } catch { /* process already closing */ }
    setTimeout(() => { if (!this.child.killed) this.child.kill(); }, 1500).unref();
  }
}

export async function transcribeLocalAudioFile(options: OfflineTranscriptionOptions): Promise<OfflineTranscriptionResult> {
  const inputPath = path.resolve(options.inputPath);
  const outputPath = path.resolve(options.outputPath);
  const inferredFormat = path.extname(outputPath).slice(1).toLowerCase();
  const format: OfflineTranscriptionFormat = options.format ?? (inferredFormat === "txt" || inferredFormat === "docx" ? inferredFormat : "md");
  const includeTimestamps = options.includeTimestamps ?? true;
  if (path.extname(outputPath).toLowerCase() !== `.${format}`) throw new Error(`输出扩展名必须是 .${format}`);
  const partialPath = format === "docx" ? `${outputPath}.partial.txt` : `${outputPath}.partial`;
  const buildingPath = `${outputPath}.building`;
  const stat = fs.statSync(inputPath);
  if (!stat.isFile()) throw new Error(`音频不存在：${inputPath}`);
  if (!options.overwrite && (fs.existsSync(outputPath) || fs.existsSync(partialPath) || fs.existsSync(buildingPath))) {
    throw new Error(`输出已存在：${fs.existsSync(outputPath) ? outputPath : partialPath}`);
  }
  const python = findPythonExecutable(options.appRoot);
  const workerPath = path.join(options.appRoot, "local_asr", "worker.py");
  const decoderPath = path.join(options.appRoot, "local_asr", "decode_audio.py");
  if (!fs.existsSync(workerPath) || !fs.existsSync(decoderPath)) throw new Error("缺少本地 ASR 转写组件");

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-offline-asr-"));
  const pcmPath = path.join(temporaryDir, "audio.s16le");
  let worker: OfflineAsrWorker | undefined;
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (options.overwrite) {
      fs.rmSync(partialPath, { force: true });
      fs.rmSync(buildingPath, { force: true });
    }
    options.onProgress?.({ phase: "decoding", message: "正在本地解码并重采样音频…" });
    await runProcess(python, [decoderPath, "--input", inputPath, "--output", pcmPath], options.signal);
    throwIfAborted(options.signal);
    const pcm = fs.readFileSync(pcmPath);
    if (pcm.length < 2) throw new Error("音频解码后为空");
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    const segments = segmentPcmBySilence(samples);
    options.onProgress?.({ phase: "segmenting", message: `已分为 ${segments.length} 段`, completedSegments: 0, totalSegments: segments.length });
    const sourceHash = await hashFile(inputPath);
    throwIfAborted(options.signal);
    const metadata: TranscriptMetadata = {
      title: `${path.basename(inputPath)} 转写`,
      sourceName: path.basename(inputPath),
      sourceHash,
      profile: options.profile,
      language: options.language,
      duration: formatAudioTimestamp(samples.length / 16_000),
    };
    fs.writeFileSync(partialPath, transcriptHeader(format === "md" ? "md" : "txt", metadata), "utf8");
    const transcriptSegments: TranscriptSegment[] = [];

    const modelRoot = path.join(options.userDataPath, "local-asr-models");
    const child = spawn(python, ["-u", workerPath], {
      cwd: options.appRoot,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        HF_HOME: process.env.HF_HOME || path.join(modelRoot, "huggingface"),
        MODELSCOPE_CACHE: process.env.MODELSCOPE_CACHE || path.join(modelRoot, "modelscope"),
      },
    });
    const abortWorker = () => child.kill();
    options.signal?.addEventListener("abort", abortWorker, { once: true });
    worker = new OfflineAsrWorker(child, (event) => {
      const label = event.model || "ASR 模型";
      options.onProgress?.({ phase: "loading", message: event.phase === "downloading" ? `正在下载 ${label}…` : `正在加载 ${label}…`, completedSegments: 0, totalSegments: segments.length });
    });
    options.onProgress?.({ phase: "loading", message: "正在加载本地 ASR…", completedSegments: 0, totalSegments: segments.length });
    await worker.configure(options.profile, options.language, options.hotwords, options.signal);

    for (let index = 0; index < segments.length; index += 1) {
      throwIfAborted(options.signal);
      const segment = segments[index];
      const start = formatAudioTimestamp(segment.startSample / 16_000);
      const end = formatAudioTimestamp(segment.endSample / 16_000);
      options.onProgress?.({ phase: "transcribing", message: `正在转写 ${start}–${end}`, completedSegments: index, totalSegments: segments.length });
      const text = await worker.transcribe(pcm.subarray(segment.startSample * 2, segment.endSample * 2), index, options.signal);
      const transcriptSegment = { start, end, text: text || "（未识别到文字）" };
      transcriptSegments.push(transcriptSegment);
      fs.appendFileSync(partialPath, formatTranscriptSegment(format === "md" ? "md" : "txt", transcriptSegment, includeTimestamps), "utf8");
      options.onProgress?.({ phase: "transcribing", message: `已完成 ${index + 1}/${segments.length} 段`, completedSegments: index + 1, totalSegments: segments.length });
    }
    throwIfAborted(options.signal);
    if (format === "docx") {
      fs.writeFileSync(buildingPath, await createTranscriptDocx(metadata, transcriptSegments, includeTimestamps));
      fs.renameSync(buildingPath, outputPath);
      fs.rmSync(partialPath, { force: true });
    } else {
      fs.renameSync(partialPath, outputPath);
    }
    return { outputPath, durationSeconds: samples.length / 16_000, segmentCount: segments.length };
  } finally {
    worker?.stop();
    fs.rmSync(temporaryDir, { recursive: true, force: true });
    fs.rmSync(buildingPath, { force: true });
  }
}
