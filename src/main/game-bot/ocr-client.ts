import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import type { OcrResult, OcrTextItem } from "./vlm-locator";

interface BridgeItem {
  text?: unknown;
  confidence?: unknown;
  bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
}

interface BridgeResponse {
  raw_text?: unknown;
  items?: unknown;
  error?: unknown;
}

export class OcrClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private responses: Array<(line: string) => void> = [];
  private serial: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly timeoutMs = 30_000,
  ) {}

  recognize(png: Buffer, width: number, height: number): Promise<OcrResult> {
    const request = this.serial.then(() => this.send(png, width, height));
    this.serial = request.catch(() => undefined);
    return request;
  }

  dispose(): void {
    const proc = this.process;
    this.process = null;
    if (!proc || proc.killed) return;
    try { proc.stdin.write('{"command":"shutdown"}\n'); } catch { /* ignore */ }
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 1000);
    proc.once("exit", () => clearTimeout(timer));
  }

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.process && !this.process.killed && this.process.exitCode === null) return this.process;
    if (!this.command) throw new Error("未配置本地 OCR 命令");
    const proc = spawn(this.command, this.args, {
      shell: false,
      windowsHide: true,
      stdio: "pipe",
      cwd: path.isAbsolute(this.command) ? path.dirname(this.command) : undefined,
    });
    this.process = proc;
    this.stdoutBuffer = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf8");
      let newline = this.stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (line) this.responses.shift()?.(line);
        newline = this.stdoutBuffer.indexOf("\n");
      }
    });
    proc.stderr.on("data", () => { /* drain to prevent a blocked child */ });
    proc.stdin.on("error", (err) => {
      const message = JSON.stringify({ error: "OCR 输入管道失败: " + err.message });
      for (const resolve of this.responses.splice(0)) resolve(message);
    });
    proc.once("error", (err) => {
      if (this.process === proc) this.process = null;
      const message = JSON.stringify({ error: "OCR 进程启动失败: " + err.message });
      for (const resolve of this.responses.splice(0)) resolve(message);
    });
    proc.once("exit", () => {
      if (this.process === proc) this.process = null;
      for (const resolve of this.responses.splice(0)) resolve('{"error":"OCR 进程已退出"}');
    });
    return proc;
  }

  private async send(png: Buffer, width: number, height: number): Promise<OcrResult> {
    const proc = this.ensureProcess();
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.responses.indexOf(onLine);
        if (index >= 0) this.responses.splice(index, 1);
        reject(new Error("OCR 请求超时"));
      }, this.timeoutMs);
      const onLine = (value: string) => { clearTimeout(timer); resolve(value); };
      this.responses.push(onLine);
      proc.stdin.write(JSON.stringify({ image_size: png.length }) + "\n");
      proc.stdin.write(png);
    });
    const response = JSON.parse(line) as BridgeResponse;
    if (typeof response.error === "string" && response.error) throw new Error(response.error);
    const items: OcrTextItem[] = [];
    if (Array.isArray(response.items)) {
      for (const raw of response.items as BridgeItem[]) {
        const text = typeof raw.text === "string" ? raw.text.trim() : "";
        const bounds = raw.bounds;
        const x = Number(bounds?.x);
        const y = Number(bounds?.y);
        const boxWidth = Number(bounds?.width);
        const boxHeight = Number(bounds?.height);
        if (!text || ![x, y, boxWidth, boxHeight].every(Number.isFinite)) continue;
        items.push({
          text,
          confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
          bounds: {
            x: x / width * 1000,
            y: y / height * 1000,
            width: boxWidth / width * 1000,
            height: boxHeight / height * 1000,
          },
        });
      }
    }
    return {
      rawText: typeof response.raw_text === "string"
        ? response.raw_text : items.map((item) => item.text).join("\n"),
      items,
    };
  }
}
