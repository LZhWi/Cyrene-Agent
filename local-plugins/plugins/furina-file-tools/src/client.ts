import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ConnectionConfig { sourceRoot: string; python: string }
export interface Job {
  id: string;
  workspace: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  artifacts: Array<{ path: string; size: number }>;
  error?: string;
  progress?: number;
}

export function validateConfig(value: unknown): ConnectionConfig {
  const config = value as ConnectionConfig | undefined;
  if (!config || typeof config.sourceRoot !== "string" || typeof config.python !== "string"
    || !path.isAbsolute(config.sourceRoot) || !path.isAbsolute(config.python)) {
    throw new Error("请在插件设置中填写 FurinaKit 源码目录和 Python 可执行文件的绝对路径");
  }
  if (!existsSync(path.join(config.sourceRoot, "cyrene-api", "server.py")) || !existsSync(config.python)) {
    throw new Error("找不到 FurinaKit API 源码或 Python 可执行文件");
  }
  return { sourceRoot: path.resolve(config.sourceRoot), python: path.resolve(config.python) };
}

export class LocalApi {
  private process?: ChildProcessWithoutNullStreams;
  private startup?: Promise<string>;
  private readonly token = randomBytes(32).toString("hex");
  private stopped = false;

  constructor(private config: ConnectionConfig, private stateDir: string) {}

  private start(): Promise<string> {
    if (this.stopped) return Promise.reject(new Error("FurinaKit 服务已停止"));
    if (this.startup) return this.startup;
    this.startup = new Promise((resolve, reject) => {
      const child = spawn(this.config.python, ["-u", path.join(this.config.sourceRoot, "cyrene-api", "server.py"),
        "--state-dir", this.stateDir, "--managed"], {
        cwd: this.config.sourceRoot,
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", FURINAKIT_API_TOKEN: this.token },
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.process = child;
      let buffer = "";
      let errorOutput = "";
      let ready = false;
      const timeout = setTimeout(() => {
        child.stdin.end();
        child.kill();
        reject(new Error("FurinaKit API 启动超时"));
      }, 15_000);
      child.stderr.on("data", (data: Buffer) => { errorOutput = (errorOutput + data.toString()).slice(-4096); });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => {
        clearTimeout(timeout);
        this.process = undefined;
        this.startup = undefined;
        if (!ready) reject(new Error(`FurinaKit API 启动失败，请运行 cyrene-api/setup.ps1。${errorOutput}`));
      });
      child.stdout.on("data", (data: Buffer) => {
        if (ready) return;
        buffer += data.toString("utf8");
        if (buffer.length > 8192) { child.kill(); reject(new Error("FurinaKit API 启动响应无效")); return; }
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        try {
          const info = JSON.parse(buffer.slice(0, end)) as { service: string; protocol: number; port: number; pid: number };
          if (info.service !== "furinakit-cyrene-api" || info.protocol !== 1 || info.pid !== child.pid
            || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) throw new Error("API 启动响应不匹配");
          ready = true;
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${info.port}`);
        } catch (error) { clearTimeout(timeout); child.kill(); reject(error); }
      });
    });
    return this.startup;
  }

  async request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const endpoint = await this.start();
    signal?.throwIfAborted();
    const response = await fetch(endpoint + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(value.error || `FurinaKit API: HTTP ${response.status}`);
    return value;
  }

  async close(): Promise<void> {
    this.stopped = true;
    const child = this.process;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      child.stdin.end(); // Server cancels its jobs and exits on EOF.
    });
  }
}
