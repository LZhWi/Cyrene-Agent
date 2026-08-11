import { spawn } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { ELEVATED_INPUT_HELPER_SCRIPT } from "./elevated-input-helper-script";

interface HelperResponse {
  ready?: boolean;
  id?: number;
  ok?: boolean;
  error?: string;
}

const CONNECT_TIMEOUT_MS = 30_000;

export function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function quotePowerShell(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export class ElevatedInputClient {
  private socket: net.Socket | null = null;
  private server: net.Server | null = null;
  private responseBuffer = "";
  private nextId = 1;
  private pending: { id: number; resolve: () => void; reject: (error: Error) => void } | null = null;
  private serial: Promise<void> = Promise.resolve();

  private constructor(private readonly processName: string) {}

  static async connect(userDataPath: string, processName: string): Promise<ElevatedInputClient> {
    const client = new ElevatedInputClient(processName);
    await client.open(userDataPath);
    return client;
  }

  click(x: number, y: number): Promise<void> {
    return this.enqueue({ op: "click", x, y });
  }

  drag(start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> {
    return this.enqueue({ op: "drag", startX: start.x, startY: start.y, endX: end.x, endY: end.y });
  }

  key(combo: string): Promise<void> {
    return this.enqueue({ op: "key", combo });
  }

  dispose(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(JSON.stringify({ op: "shutdown" }) + "\n");
      this.socket.end();
    }
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.pending?.reject(new Error("管理员输入助手已关闭"));
    this.pending = null;
  }

  private enqueue(payload: Record<string, unknown>): Promise<void> {
    const request = this.serial.then(() => this.send(payload));
    this.serial = request.catch(() => undefined);
    return request;
  }

  private send(payload: Record<string, unknown>): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) return Promise.reject(new Error("管理员输入助手未连接"));
    const id = this.nextId++;
    return new Promise<void>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      socket.write(JSON.stringify({ id, ...payload }) + "\n", (error) => {
        if (error && this.pending?.id === id) {
          this.pending = null;
          reject(error);
        }
      });
    });
  }

  private async open(userDataPath: string): Promise<void> {
    const helperDir = path.join(userDataPath, "game-bot");
    const scriptPath = path.join(helperDir, "elevated-input-helper.ps1");
    fs.mkdirSync(helperDir, { recursive: true });
    fs.writeFileSync(scriptPath, ELEVATED_INPUT_HELPER_SCRIPT, "utf8");

    const pipeName = `cyrene-gamebot-input-${process.pid}-${randomUUID()}`;
    const pipePath = `\\\\.\\pipe\\${pipeName}`;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.socket?.destroy();
          this.server?.close();
          this.socket = null;
          this.server = null;
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => finish(new Error("管理员输入助手未连接；可能取消了 UAC 确认")), CONNECT_TIMEOUT_MS);
      this.server = net.createServer((socket) => {
        if (this.socket) return socket.destroy();
        this.socket = socket;
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => this.onData(chunk, () => finish()));
        socket.on("error", (error) => {
          this.pending?.reject(error);
          this.pending = null;
          if (!settled) finish(error);
        });
        socket.on("close", () => {
          this.pending?.reject(new Error("管理员输入助手连接已断开"));
          this.pending = null;
        });
      });
      this.server.once("error", (error) => finish(error));
      this.server.listen(pipePath, () => {
        const helperArgs = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" -PipeName "${pipeName}" -GameProcessName "${this.processName}"`;
        const launchCommand = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList ${quotePowerShell(helperArgs)}`;
        const launcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShellCommand(launchCommand)], {
          windowsHide: true,
          stdio: "ignore",
        });
        launcher.once("error", (error) => finish(error));
        launcher.once("exit", (code) => {
          if (code && code !== 0) finish(new Error("管理员输入助手启动失败或 UAC 被取消"));
        });
        launcher.unref();
      });
    });
    this.server?.close();
    this.server = null;
  }

  private onData(chunk: string, onReady: () => void): void {
    this.responseBuffer += chunk;
    let newline = this.responseBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.responseBuffer.slice(0, newline).trim();
      this.responseBuffer = this.responseBuffer.slice(newline + 1);
      if (line) {
        try {
          const response = JSON.parse(line) as HelperResponse;
          if (response.ready) onReady();
          else if (this.pending && response.id === this.pending.id) {
            const pending = this.pending;
            this.pending = null;
            if (response.ok) pending.resolve();
            else pending.reject(new Error(response.error || "管理员输入操作失败"));
          }
        } catch {
          this.pending?.reject(new Error("管理员输入助手返回了无效响应"));
          this.pending = null;
        }
      }
      newline = this.responseBuffer.indexOf("\n");
    }
  }
}
