import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const controls = ["up", "down", "left", "right", "A", "B", "X", "Y", "LB", "RB", "Start", "Back", "LeftThumb", "RightThumb", "DpadUp", "DpadDown", "DpadLeft", "DpadRight", "RT"];
export function validatePulse(value: unknown) {
  const input = value as Record<string, unknown>;
  if (!input || (input.pad !== 1 && input.pad !== 2)) throw new Error("手柄应为 1 或 2");
  if (typeof input.control !== "string" || !controls.includes(input.control)) throw new Error("未知测试按键");
  if (!Number.isInteger(input.durationMs) || Number(input.durationMs) < 50 || Number(input.durationMs) > 1000) throw new Error("脉冲应为 50..1000 毫秒");
  if (!Number.isInteger(input.delayMs) || Number(input.delayMs) < 2000 || Number(input.delayMs) > 10000) throw new Error("延迟应为 2000..10000 毫秒");
  if (input.pad === 1 && input.confirmP1 !== true) throw new Error("第一只手柄仅用于手动初始化，需要明确确认");
  return { pad: input.pad, control: input.control, durationMs: Number(input.durationMs), delayMs: Number(input.delayMs), confirmP1: input.confirmP1 === true };
}

export function validateFollow(value: unknown, observeOnly: boolean) {
  const input = value as Record<string, unknown>;
  if (!input || !Number.isInteger(input.delayMs) || Number(input.delayMs) < 2000 || Number(input.delayMs) > 10000) throw new Error("延迟应为 2000..10000 毫秒");
  if (!observeOnly && input.confirmCamp !== true) throw new Error("先确认营地空地、第二只控制 P2，并在校准时保持 P1 静止");
  return { delayMs: Number(input.delayMs), confirmCamp: input.confirmCamp === true };
}

export class InputManager {
  private child?: ChildProcessWithoutNullStreams;
  private heartbeat?: ReturnType<typeof setInterval>;
  private shutdown?: Promise<void>;
  private closed = false;
  private state: any = { ready: false, pads: [] };
  private results: any[] = [];
  private notices: string[] = [];
  private pending?: string;
  private probes = new Set<ChildProcessWithoutNullStreams>();
  private followState: any = { phase: "idle", reason: "尚未启动" };
  constructor(private runtime: string, private launch = spawn) {}
  status() { return { running: !!this.child, state: this.state, results: [...this.results], notices: [...this.notices], follow: this.followState }; }
  private followBusy() { return ["requested", "countdown", "baseline", "right", "up", "following"].includes(this.followState.phase); }
  private notice(value: string) { this.notices.push(value.slice(0, 2000)); if (this.notices.length > 20) this.notices.shift(); }
  private executable() { return path.join(this.runtime, "DungeonsInput.exe"); }
  private options() { return { cwd: this.runtime, windowsHide: true, stdio: "pipe" as const }; }
  private read(child: ChildProcessWithoutNullStreams, receive: (message: any) => void) {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      // A single explicit observation may contain one local PNG preview.
      if (buffer.length > 8 * 1024 * 1024) { this.notice("子进程输出超限"); child.kill(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        try { if (line) receive(JSON.parse(line)); } catch { this.notice("子进程消息无效"); }
      }
    });
    child.stderr.on("data", chunk => this.notice(String(chunk)));
  }
  async probe() {
    if (this.closed) throw new Error("插件已停止");
    // --probe connects to the bus but never creates targets or sends input.
    return new Promise<any>((resolve, reject) => {
      const child = this.launch(this.executable(), ["--probe"], this.options());
      this.probes.add(child);
      let result: any;
      const deadline = setTimeout(() => { child.kill(); reject(new Error("驱动检查超时")); }, 10000);
      this.read(child, message => { result = message; });
      child.once("error", error => { clearTimeout(deadline); reject(error); });
      child.once("close", () => { this.probes.delete(child); clearTimeout(deadline); result ? resolve(result) : reject(new Error("驱动检查未返回结果")); });
    });
  }
  start() {
    if (this.closed) throw new Error("插件已停止");
    if (this.child) throw new Error("测试手柄已经启动或正在退出");
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("测试版需要 Windows x64");
    this.results = []; this.notices = []; this.pending = undefined; this.state = { ready: false, pads: [] };
    this.followState = { phase: "idle", reason: "尚未启动" };
    const child = this.launch(this.executable(), [], this.options()); this.child = child;
    this.read(child, message => {
      if (this.child !== child) return;
      if (message.type === "state") this.state = message;
      else if (message.type === "follow") this.followState = message;
      else if (message.type === "result") {
        const index = this.results.findIndex(entry => entry.id === message.id);
        if (index >= 0) this.results[index] = message; else this.results.push(message);
        if (this.results.length > 30) this.results.shift();
        if (message.status !== "scheduled" && message.status !== "active" && message.id === this.pending) this.pending = undefined;
      } else this.notice(message.error || message.reason || JSON.stringify(message));
    });
    this.heartbeat = setInterval(() => this.send({ type: "heartbeat" }), 500);
    child.stdin.on("error", error => this.notice(error.message));
    child.once("error", error => this.notice(error.message));
    child.once("close", () => {
      if (this.child !== child) return;
      clearInterval(this.heartbeat); this.heartbeat = undefined; this.child = undefined;
      if (this.pending) this.results.push({ id: this.pending, status: "disconnected", reason: "输入进程退出；不重放请求。发送过的输入不等于游戏动作成功。" });
      this.pending = undefined; this.state = { ...this.state, ready: false, pads: [] };
      this.followState = { phase: "stopped", reason: "输入进程退出；不会恢复跟随" };
    });
    return this.status();
  }
  private send(message: unknown) { if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(message) + "\n"); }
  pulse(value: unknown) {
    const request = validatePulse(value);
    if (this.closed || !this.child || !this.state.ready) throw new Error("先创建两只测试手柄");
    if (this.pending) throw new Error("已有脉冲排队或执行，先等待或停止");
    if (this.followBusy()) throw new Error("先停止观察/跟随，再手动输入");
    const id = randomUUID(); this.pending = id;
    const result = { id, status: "scheduled", ...request }; this.results.push(result);
    this.send({ type: "pulse", id, ...request }); return result;
  }
  follow(value: unknown, observeOnly = false) {
    const request = validateFollow(value, observeOnly);
    if (this.closed || !this.child || !this.state.ready) throw new Error("先创建两只测试手柄");
    if (this.pending || this.followBusy()) throw new Error("已有脉冲或观察/跟随，先等待或停止");
    this.followState = { phase: "requested", reason: "请求已提交，等待输入进程确认", observeOnly };
    this.send({ type: observeOnly ? "follow-observe" : "follow-start", ...request });
    return this.followState;
  }
  cancel() { this.send({ type: "cancel" }); return { requested: true }; }
  async stop() {
    if (this.shutdown) return this.shutdown;
    const child = this.child; if (!child) return;
    this.shutdown = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        // Only the worker owned by this manager; never the game or other tools.
        child.kill();
        forceDeadline = setTimeout(() => reject(new Error("子进程尚未确认退出，请检查状态")), 2000);
      }, 2000);
      let forceDeadline: ReturnType<typeof setTimeout> | undefined;
      child.once("close", () => { clearTimeout(deadline); clearTimeout(forceDeadline); resolve(); });
      this.send({ type: "stop" });
    }).finally(() => { this.shutdown = undefined; });
    return this.shutdown;
  }
  async close() { this.closed = true; for (const child of this.probes) child.kill(); await this.stop(); }
}
