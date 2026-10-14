import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";

export interface Connection {
  host: string; port: number; username: string; owner: string;
  auth: "offline" | "microsoft"; version: string;
  autoSurvival: boolean;
}

export function validateConnection(value: unknown): Connection {
  if (!value || typeof value !== "object") throw new Error("连接设置无效");
  const config = value as Record<string, unknown>;
  const name = (key: string, max: number) => {
    const value = config[key];
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\s\x00-\x1f]/.test(value)) throw new Error(`${key} 无效`);
    return value;
  };
  if (!Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65535) throw new Error("端口应为 1..65535");
  if (config.auth !== "offline" && config.auth !== "microsoft") throw new Error("登录方式无效");
  if (typeof config.version !== "string" || !/^(?:|1\.\d+(?:\.\d+)?)$/.test(config.version)) throw new Error("版本应为空（自动）或 Java 版版本号");
  const username = name("username", config.auth === "offline" ? 16 : 254);
  const owner = name("owner", 16);
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(owner) || (config.auth === "offline" && !/^[a-zA-Z0-9_]{1,16}$/.test(username))) throw new Error("玩家名只能含字母、数字和下划线");
  if (config.autoSurvival !== undefined && typeof config.autoSurvival !== "boolean") throw new Error("自动生存选项无效");
  return { host: name("host", 253), port: Number(config.port), username, owner, auth: config.auth, version: config.version, autoSurvival: config.autoSurvival === true };
}

type Message = { type: string; id?: string; data?: any };
export class BodyManager {
  private child?: ChildProcess;
  private starting = false;
  private stopping?: Promise<void>;
  private closed = false;
  private state: any = { connected: false };
  private login?: { url: string; code: string };
  private results: any[] = [];
  private notices: any[] = [];
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private runtime: string, private dataRoot: string, private spawn = fork) {}

  status() {
    return { running: !!this.child, starting: this.starting, state: this.state,
      login: this.login, results: [...this.results], notices: [...this.notices] };
  }

  private notice(data: unknown) {
    this.notices.push({ time: new Date().toISOString(), data });
    if (this.notices.length > 30) this.notices.shift();
  }

  private message(child: ChildProcess, message: Message) {
    if (this.child !== child || this.closed || !message || typeof message.type !== "string") return;
    if (message.type === "state") {
      this.state = message.data;
      if (this.state.connected) this.login = undefined;
    }
    else if (message.type === "login") this.login = message.data;
    else if (message.type === "result" || message.type === "rejected") {
      const result = message.type === "result" ? message.data : { id: message.id, status: "rejected", reason: message.data };
      if (typeof result?.id !== "string") { this.notice(message.data); return; }
      if (result.status !== "active") {
        clearTimeout(this.pending.get(result.id));
        this.pending.delete(result.id);
      }
      const previous = this.results.findIndex((entry) => entry.id === result.id);
      if (previous >= 0) this.results[previous] = result;
      else this.results.push(result);
      if (this.results.length > 50) this.results.shift();
    } else if (message.type === "ended") {
      this.state = { ...this.state, connected: false };
      this.notice(message.data);
    } else this.notice(message.data);
  }

  private lost(child: ChildProcess, reason: string) {
    if (this.child !== child) return;
    this.child = undefined;
    this.login = undefined;
    this.state = { ...this.state, connected: false, activeAction: null };
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    this.results = this.results.map((result) => ["submitted", "active"].includes(result.status)
      ? { ...result, status: "disconnected", reason, effectsUncertain: ["collect", "craft", "give", "pickup", "eat", "equip", "equip_armor", "equip_shield", "place", "deposit", "withdraw", "sleep", "wake", "door", "till", "plant", "harvest", "smelt", "defend", "escape"].includes(result.action) } : result);
    this.notice(reason);
  }

  private failed(child: ChildProcess, reason: string) {
    if (this.child !== child) return;
    this.state = { ...this.state, connected: false };
    this.notice(reason);
    // A failed spawn has no process; otherwise hold the slot until its exit.
    if (!child.pid) this.lost(child, reason);
    child.kill();
  }

  async start(value: unknown) {
    if (this.closed) throw new Error("插件已停止");
    if (this.child || this.starting) throw new Error("身体已经运行或正在启动");
    const config = validateConnection(value);
    this.starting = true;
    try {
      await mkdir(this.dataRoot, { recursive: true });
      const root = await realpath(this.dataRoot);
      const profiles = path.join(root, "microsoft-auth");
      await mkdir(profiles, { recursive: true });
      if (path.dirname(await realpath(profiles)) !== root) throw new Error("登录缓存目录不能链接到插件数据目录外");
      if (this.closed) throw new Error("插件已停止");
      this.results = [];
      this.login = undefined;
      this.state = { connected: false };
      const options: ForkOptions & { windowsHide: boolean } = {
        execArgv: [],
        cwd: this.runtime, stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: "" }, windowsHide: true,
      };
      const child = this.spawn(path.join(this.runtime, "sidecar.cjs"), [], options);
      this.child = child;
      child.on("message", (message) => this.message(child, message as Message));
      child.once("exit", () => this.lost(child, "身体进程已退出，动作不会重放"));
      child.once("error", (error) => this.failed(child, error.message));
      child.send({ type: "start", config, profilesFolder: profiles }, (error) => {
        if (error) this.failed(child, error.message);
      });
      return this.status();
    } finally { this.starting = false; }
  }

  action(value: unknown) {
    if (this.closed || !this.child?.connected || !this.state.connected) throw new Error("等待机器人出生后再执行动作");
    const input = value as Record<string, unknown>;
    const id = randomUUID();
    // The runtime owns action validation too; never accept a caller-chosen ID.
    const request = { id, action: input?.action, material: input?.material, count: input?.count, timeoutMs: input?.timeoutMs, position: input?.position, open: input?.open };
    const { validateAction } = require(path.join(this.runtime, "body.cjs"));
    validateAction(request);
    if (this.state.activeAction || this.pending.size) throw new Error("已有动作运行，请先停止");
    const child = this.child;
    const result = { id, action: request.action, status: "submitted" };
    this.results.push(result);
    if (this.results.length > 50) this.results.shift();
    // A lost IPC response is uncertain, never a reason to resend a world mutation.
    this.pending.set(id, setTimeout(() => {
      this.notice("身体未在截止时间返回结果；关闭身体，不自动重试");
      void this.stop().catch((error) => this.notice(error.message));
    }, Number(request.timeoutMs ?? 60000) + 5000));
    child.send({ type: "action", request }, (error) => {
      if (error) this.failed(child, error.message);
    });
    return result;
  }

  cancel() {
    if (!this.closed && this.child?.connected) this.child.send({ type: "cancel" }, (error) => { if (error) this.notice(error.message); });
    return { requested: true };
  }

  async stop() {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return;
    this.stopping = new Promise<void>((resolve, reject) => {
      let failureTimer: ReturnType<typeof setTimeout> | undefined;
      const force = () => {
        failureTimer ??= setTimeout(() => {
          this.state = { ...this.state, connected: false };
          reject(new Error("身体进程尚未确认退出；保留句柄，禁止再次连接"));
        }, 2000);
        child.kill();
      };
      const timer = setTimeout(force, 2000);
      child.once("exit", () => { clearTimeout(timer); clearTimeout(failureTimer); resolve(); });
      if (child.connected) child.send({ type: "stop" }, (error) => { if (error) force(); });
      else force();
    });
    try {
      await this.stopping;
      this.lost(child, "身体已断开，动作不会重放");
    } finally { this.stopping = undefined; }
  }

  async close() { this.closed = true; await this.stop(); }
}
