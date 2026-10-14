import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string } };
export interface RpcClient {
  request(method: string, params: unknown): Promise<any>;
  respond(id: number | string, result: unknown): void;
  reject(id: number | string, message: string): void;
  close(): void | Promise<void>;
}

export function resolveCodex(configured: string): string {
  if (configured) {
    if (!path.isAbsolute(configured) || !statSync(configured).isFile()) throw new Error("Codex 路径必须指向可执行文件的绝对路径");
    return configured;
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const root = path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
    if (existsSync(root)) {
      const files = readdirSync(root).map(name => path.join(root, name, "codex.exe"))
        .filter(file => existsSync(file)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      if (files[0]) return files[0];
    }
  }
  return process.platform === "win32" ? "codex.exe" : "codex";
}

export class AppServerClient implements RpcClient {
  private process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private closed = false;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(executable: string, cwd: string, onEvent: (message: RpcMessage) => void, onClose: (reason: string) => void) {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    this.process = spawn(resolveCodex(executable), ["app-server", "--stdio", "-c", 'model_provider="openai"',
      "-c", 'forced_login_method="chatgpt"'], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const fail = (reason: string) => {
      if (this.closed) return;
      this.closed = true;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
      this.pending.clear();
      onClose(reason);
    };
    this.process.on("error", error => fail(error.message));
    this.process.on("exit", code => fail(`Codex 连接已关闭 (${code ?? "signal"})；未自动重发任务`));
    this.process.stdin.on("error", error => fail(error.message));
    // Do not forward stderr: third-party tool startup logs can contain credentials.
    this.process.stderr.resume();
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", line => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id === "number" && !message.method) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
      } else onEvent(message);
    });
  }

  private write(message: RpcMessage): void {
    if (this.closed) throw new Error("Codex 尚未连接");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "cyrene_codex_bridge", title: "Cyrene Codex Bridge", version: "0.2.0" }, capabilities: { experimentalApi: true } });
    this.write({ method: "initialized", params: {} });
  }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 响应超时；未自动重试，请核对任务状态`)); }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id: number | string, result: unknown): void { this.write({ id, result }); }
  reject(id: number | string, message: string): void { this.write({ id, error: { message, code: -32601 } } as RpcMessage); }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Codex 连接已关闭")); }
    this.pending.clear();
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    await new Promise<void>(resolve => {
      this.process.once("exit", () => resolve());
      this.process.stdin.end();
      this.process.kill();
    });
    this.process.stdout.destroy();
    this.process.stderr.destroy();
    this.process.stdin.destroy();
  }
}
