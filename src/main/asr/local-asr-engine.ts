import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { AsrConfig } from "./volcano-asr-engine";

const LOG_PREFIX = "[LocalASR]";
const DOWNLOAD_TIMEOUT_MS = 60 * 60_000;
const MODEL_LOAD_TIMEOUT_MS = 10 * 60_000;
const FINAL_TIMEOUT_MS = 2 * 60_000;

type LocalProfile = AsrConfig["localProfile"];

interface SessionCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  resolveFinal?: () => void;
  rejectFinal?: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  error?: Error;
}

interface WorkerEvent {
  type?: string;
  sessionId?: string;
  text?: string;
  message?: string;
  profile?: LocalProfile;
  phase?: "downloading" | "loading";
  model?: string;
}

export interface LocalAsrStatus {
  phase: "downloading" | "loading";
  model?: string;
}

function findPythonExecutable(): string {
  const override = process.env.CYRENE_ASR_PYTHON?.trim();
  if (override) return override;

  const appRoot = app.getAppPath();
  const candidates = process.platform === "win32"
    ? [
      path.join(appRoot, ".venv-asr", "Scripts", "python.exe"),
      path.join(process.cwd(), ".venv-asr", "Scripts", "python.exe"),
    ]
    : [
      path.join(appRoot, ".venv-asr", "bin", "python"),
      path.join(process.cwd(), ".venv-asr", "bin", "python"),
    ];
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error("本地 ASR 环境尚未安装，请先运行 scripts/setup-local-asr.ps1");
  }
  return executable;
}

class LocalAsrRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private configuredSignature = "";
  private configureResolve: (() => void) | null = null;
  private configureReject: ((error: Error) => void) | null = null;
  private configureStatus: ((status: LocalAsrStatus) => void) | null = null;
  private configureTimeout: NodeJS.Timeout | null = null;
  private sessions = new Map<string, SessionCallbacks>();

  async startSession(
    config: AsrConfig,
    callbacks: Pick<SessionCallbacks, "onPartial" | "onFinal">,
    onStatus?: (status: LocalAsrStatus) => void,
  ): Promise<string> {
    this.configureStatus = onStatus ?? null;
    try {
      await this.ensureConfigured(config);
    } finally {
      this.configureStatus = null;
    }
    const sessionId = randomUUID();
    this.sessions.set(sessionId, callbacks);
    this.send({ type: "start", sessionId });
    return sessionId;
  }

  sendAudio(sessionId: string, pcm: Buffer): void {
    if (!pcm.length || !this.sessions.has(sessionId)) return;
    this.send({ type: "audio", sessionId, pcm: pcm.toString("base64") });
  }

  flushSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.send({ type: "flush", sessionId });
  }

  finishSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return Promise.resolve();
    if (session.error) {
      this.sessions.delete(sessionId);
      return Promise.reject(session.error);
    }
    if (session.resolveFinal) {
      return new Promise<void>((resolve, reject) => {
        const originalResolve = session.resolveFinal!;
        const originalReject = session.rejectFinal!;
        session.resolveFinal = () => { originalResolve(); resolve(); };
        session.rejectFinal = (error) => { originalReject(error); reject(error); };
      });
    }

    return new Promise<void>((resolve, reject) => {
      session.resolveFinal = resolve;
      session.rejectFinal = reject;
      session.timeout = setTimeout(() => {
        this.sessions.delete(sessionId);
        reject(new Error("本地 ASR 句末复核超时"));
      }, FINAL_TIMEOUT_MS);
      this.send({ type: "finish", sessionId });
    });
  }

  cancelSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.timeout) clearTimeout(session.timeout);
    this.sessions.delete(sessionId);
    this.send({ type: "cancel", sessionId });
  }

  shutdown(): void {
    if (!this.child) return;
    const child = this.child;
    if (this.configureReject) {
      child.kill();
      this.reset(new Error("本地 ASR 已关闭"));
      return;
    }
    this.send({ type: "shutdown" });
    setTimeout(() => {
      if (!child.killed) child.kill();
    }, 1500).unref();
    this.reset(new Error("本地 ASR 已关闭"));
  }

  private async ensureConfigured(config: AsrConfig): Promise<void> {
    this.ensureProcess();
    const hotwords = config.hotwords.map((word) => word.trim()).filter(Boolean).slice(0, 200);
    const signature = JSON.stringify([config.localProfile, config.language, hotwords]);
    if (this.configuredSignature === signature) return;

    if (this.configureReject) {
      this.configureReject(new Error("本地 ASR 配置已被新的启动请求替换"));
      this.clearConfigureWaiter();
    }

    await new Promise<void>((resolve, reject) => {
      this.configureResolve = () => {
        this.configuredSignature = signature;
        this.clearConfigureWaiter();
        resolve();
      };
      this.configureReject = (error) => {
        this.clearConfigureWaiter();
        reject(error);
      };
      this.armConfigureTimeout(DOWNLOAD_TIMEOUT_MS, "本地 ASR 模型下载超时");
      this.send({
        type: "configure",
        profile: config.localProfile,
        language: config.language,
        hotwords,
      });
    });
  }

  private ensureProcess(): void {
    if (this.child && !this.child.killed) return;
    const workerPath = path.join(app.getAppPath(), "local_asr", "worker.py");
    if (!fs.existsSync(workerPath)) throw new Error(`缺少本地 ASR worker：${workerPath}`);

    const executable = findPythonExecutable();
    const modelCacheDir = path.join(app.getPath("userData"), "local-asr-models");
    fs.mkdirSync(modelCacheDir, { recursive: true });
    console.log(LOG_PREFIX, "启动 worker:", executable);
    const child = spawn(executable, ["-u", workerPath], {
      cwd: app.getAppPath(),
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        HF_HOME: process.env.HF_HOME || path.join(modelCacheDir, "huggingface"),
        MODELSCOPE_CACHE: process.env.MODELSCOPE_CACHE || path.join(modelCacheDir, "modelscope"),
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    readline.createInterface({ input: child.stderr }).on("line", (line) => console.log(LOG_PREFIX, line));
    child.on("error", (error) => this.reset(new Error(`无法启动本地 ASR：${error.message}`)));
    child.on("exit", (code) => {
      if (this.child === child) this.reset(new Error(`本地 ASR 进程已退出（code=${code ?? "null"}）`));
    });
  }

  private handleLine(line: string): void {
    let event: WorkerEvent;
    try {
      event = JSON.parse(line) as WorkerEvent;
    } catch {
      if (line.trim()) console.log(LOG_PREFIX, line);
      return;
    }

    if (event.type === "ready") {
      this.configureResolve?.();
      return;
    }
    if (event.type === "status" && (event.phase === "downloading" || event.phase === "loading")) {
      const timeoutMs = event.phase === "downloading" ? DOWNLOAD_TIMEOUT_MS : MODEL_LOAD_TIMEOUT_MS;
      const timeoutMessage = event.phase === "downloading"
        ? "本地 ASR 模型下载超时"
        : "本地 ASR 模型加载超时";
      this.armConfigureTimeout(timeoutMs, timeoutMessage);
      this.configureStatus?.({ phase: event.phase, model: event.model });
      return;
    }
    if (event.type === "error" && !event.sessionId) {
      this.configureReject?.(new Error(event.message || "本地 ASR 初始化失败"));
      return;
    }
    if (!event.sessionId) return;

    const session = this.sessions.get(event.sessionId);
    if (!session) return;
    if (event.type === "partial" && event.text) {
      session.onPartial(event.text);
    } else if (event.type === "final") {
      const text = event.text?.trim() ?? "";
      if (text) session.onFinal(text);
      if (session.timeout) clearTimeout(session.timeout);
      this.sessions.delete(event.sessionId);
      session.resolveFinal?.();
    } else if (event.type === "error") {
      const error = new Error(event.message || "本地 ASR 识别失败");
      if (session.rejectFinal) {
        if (session.timeout) clearTimeout(session.timeout);
        this.sessions.delete(event.sessionId);
        session.rejectFinal(error);
      } else {
        session.error = error;
      }
    }
  }

  private send(command: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error("本地 ASR 进程不可用");
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  private clearConfigureWaiter(): void {
    if (this.configureTimeout) clearTimeout(this.configureTimeout);
    this.configureTimeout = null;
    this.configureResolve = null;
    this.configureReject = null;
    this.configureStatus = null;
  }

  private armConfigureTimeout(timeoutMs: number, message: string): void {
    if (this.configureTimeout) clearTimeout(this.configureTimeout);
    this.configureTimeout = setTimeout(() => {
      const child = this.child;
      this.configureReject?.(new Error(message));
      if (child && !child.killed) child.kill();
    }, timeoutMs);
  }

  private reset(error: Error): void {
    this.child = null;
    this.configuredSignature = "";
    this.configureReject?.(error);
    this.clearConfigureWaiter();
    for (const session of this.sessions.values()) {
      if (session.timeout) clearTimeout(session.timeout);
      session.rejectFinal?.(error);
    }
    this.sessions.clear();
  }
}

const runtime = new LocalAsrRuntime();

export class LocalAsrStream {
  private sessionId: string | null = null;
  private stopped = false;

  constructor(
    private readonly onPartial: (text: string) => void,
    private readonly onFinal: (text: string) => void,
    private readonly onStatus?: (status: LocalAsrStatus) => void,
  ) {}

  async start(config: AsrConfig): Promise<void> {
    this.stopped = false;
    this.sessionId = await runtime.startSession(config, {
      onPartial: this.onPartial,
      onFinal: this.onFinal,
    }, this.onStatus);
  }

  sendAudio(frame: Buffer): void {
    if (!this.stopped && this.sessionId) runtime.sendAudio(this.sessionId, frame);
  }

  flush(): void {
    if (!this.stopped && this.sessionId) runtime.flushSession(this.sessionId);
  }

  async finish(): Promise<void> {
    if (this.stopped || !this.sessionId) return;
    this.stopped = true;
    const sessionId = this.sessionId;
    this.sessionId = null;
    await runtime.finishSession(sessionId);
  }

  stop(): void {
    if (this.stopped || !this.sessionId) return;
    this.stopped = true;
    runtime.cancelSession(this.sessionId);
    this.sessionId = null;
  }
}

export function shutdownLocalAsr(): void {
  runtime.shutdown();
}
