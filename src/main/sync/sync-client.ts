// sync/sync-client —— 框架无关的同步传输客户端（无 electron / 无 RN 依赖）。
//
// PC 与 RN 共享：只依赖标准 fetch。RN 侧直接实例化即可与 PC 的
// /sync/pull /sync/push 端点通信（同一局域网）。
//
// 职责：
//   - pull(since)：拉取 PC 的增量快照。
//   - push(snapshot)：把本端快照推给 PC 合并，返回新游标。
//   - 统一注入 X-Cyrene-Channel-Secret 鉴权头。
//
// 游标持久化交由调用方（RN=SQLite/AsyncStorage，测试=内存），本模块不落盘。

import type { SyncPullResponse, SyncPushResponse, SyncSnapshot } from "./types";

export interface SyncClientOptions {
  /** PC 同步服务基址，如 http://192.168.1.10:8790（无尾斜杠）。 */
  baseUrl: string;
  /** 与 PC 共享的密钥（X-Cyrene-Channel-Secret）。 */
  secret: string;
  /** 本端设备标识（写入 push 快照来源）。 */
  deviceId: string;
  /** 注入的 fetch 实现，缺省用全局 fetch（RN / Node18+ 均自带）。 */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（ms），默认 15s。 */
  timeoutMs?: number;
}

export class SyncError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "SyncError";
  }
}

export class SyncClient {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly deviceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: SyncClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.secret = opts.secret;
    this.deviceId = opts.deviceId;
    const f = opts.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) {
      throw new SyncError("SyncClient: 当前环境无 fetch，请通过 fetchImpl 注入");
    }
    this.fetchImpl = f;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get device(): string {
    return this.deviceId;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-cyrene-channel-secret": this.secret,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (!res.ok || !json || json.ok !== true) {
        const errMsg = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
        throw new SyncError(errMsg, res.status);
      }
      return json;
    } catch (err) {
      if (err instanceof SyncError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new SyncError(`sync request failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 拉取 PC 自 since(ms) 以来的增量快照。since=0 拉全量。 */
  async pull(since = 0): Promise<SyncPullResponse> {
    const q = since > 0 ? `?since=${encodeURIComponent(String(since))}` : "";
    return (await this.request("GET", `/sync/pull${q}`)) as SyncPullResponse;
  }

  /** 把本端快照推给 PC 合并。会强制覆盖 deviceId 为本端。 */
  async push(snapshot: SyncSnapshot): Promise<SyncPushResponse> {
    const payload: SyncSnapshot = { ...snapshot, deviceId: this.deviceId };
    return (await this.request("POST", "/sync/push", payload)) as SyncPushResponse;
  }
}
