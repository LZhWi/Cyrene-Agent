/**
 * ClineRuntimeManager - 应用级 ClineCore 单例
 *
 * 职责：
 * - create 一次：应用启动或首次 Code 请求时
 * - 管理多个 session
 * - 订阅和释放事件监听器
 * - 处理并发、取消和异常
 *
 * 并发安全：使用 runtimePromise 防止两个首次请求同时创建两个 Runtime。
 */

import * as path from "path";
import { pathToFileURL } from "url";

export interface StartSessionInput {
  config: Record<string, unknown>;
  prompt?: string;
  interactive?: boolean;
  initialMessages?: unknown[];
  capabilities?: { toolExecutors?: Record<string, unknown> };
}

export interface SendInput {
  sessionId: string;
  prompt: string;
  mode?: string;
}

export interface CoreSessionEvent {
  type: string;
  payload?: unknown;
}

export interface AgentResult {
  finishReason: string;
  text?: string;
  usage?: unknown;
}

class ClineRuntimeManager {
  private cline: any | null = null;
  private runtimePromise: Promise<any> | null = null;
  /** 内存中活跃的 sessionId 集合 */
  private activeSessionIds: Set<string> = new Set();
  /** sessionId -> session 创建时间 */
  private sessionMeta: Map<string, { createdAt: number; cwd: string }> = new Map();

  /** 获取 Runtime，确保只创建一次 */
  async ensureRuntime(): Promise<any> {
    if (this.cline) return this.cline;
    if (this.runtimePromise) return this.runtimePromise;

    this.runtimePromise = this.createRuntime();
    try {
      this.cline = await this.runtimePromise;
      return this.cline;
    } finally {
      this.runtimePromise = null;
    }
  }

  private async createRuntime(): Promise<any> {
    const bridgePath = path.join(__dirname, "cline-esm-bridge.mjs");
    const bridgeUrl = pathToFileURL(bridgePath).href;
    const bridge = await import(bridgeUrl);
    return bridge.createClineCore({
      clientName: "cyrene",
      backendMode: "local",
    });
  }

  /** 检查 sessionId 是否在内存中活跃 */
  isSessionActive(sessionId: string): boolean {
    return this.activeSessionIds.has(sessionId);
  }

  /** 标记 session 活跃（由 start/dispatchResult 调用） */
  markSessionActive(sessionId: string, cwd: string): void {
    this.activeSessionIds.add(sessionId);
    this.sessionMeta.set(sessionId, { createdAt: Date.now(), cwd });
  }

  /** 获取 session 元数据 */
  getSessionMeta(sessionId: string): { createdAt: number; cwd: string } | undefined {
    return this.sessionMeta.get(sessionId);
  }

  /** 取消所有活跃 session */
  async abortAllSessions(reason: string = "shutdown"): Promise<void> {
    if (!this.cline) return;
    for (const sessionId of this.activeSessionIds) {
      try {
        await this.cline.abort(sessionId, reason);
      } catch { /* ignore */ }
    }
  }

  /** 启动新 Session */
  async start(input: StartSessionInput): Promise<{ sessionId: string; result?: AgentResult }> {
    const cline = await this.ensureRuntime();
    const result = await cline.start(input);
    if (result.sessionId) {
      this.markSessionActive(result.sessionId, (input.config as { cwd?: string })?.cwd ?? "");
    }
    return result;
  }

  /** 在已有 Session 上继续 */
  async send(input: SendInput): Promise<AgentResult | undefined> {
    const cline = await this.ensureRuntime();
    if (!this.activeSessionIds.has(input.sessionId)) {
      throw new Error(`SESSION_NOT_ACTIVE: ${input.sessionId} is not active in this Runtime`);
    }
    return cline.send(input);
  }

  /** 读取消息（跨实例可用） */
  async readMessages(sessionId: string): Promise<unknown[]> {
    const cline = await this.ensureRuntime();
    return cline.readMessages(sessionId);
  }

  /** 获取 session 信息 */
  async get(sessionId: string): Promise<unknown | undefined> {
    const cline = await this.ensureRuntime();
    return cline.get(sessionId);
  }

  /** 获取累计 token usage */
  async getAccumulatedUsage(sessionId: string): Promise<any> {
    const cline = await this.ensureRuntime();
    return cline.getAccumulatedUsage(sessionId);
  }

  /** 结束 Session */
  async stop(sessionId: string): Promise<void> {
    if (!this.cline) return;
    try {
      await this.cline.stop(sessionId);
    } finally {
      this.activeSessionIds.delete(sessionId);
      this.sessionMeta.delete(sessionId);
    }
  }

  /** 订阅 Session 事件 */
  subscribe(sessionId: string, listener: (event: CoreSessionEvent) => void): () => void {
    // 直接调用 cline.subscribe；filter by sessionId
    if (!this.cline) {
      return () => {};
    }
    return this.cline.subscribe(listener, { sessionId });
  }

  /** 销毁整个 Runtime */
  async dispose(): Promise<void> {
    if (this.cline) {
      try {
        await this.cline.dispose();
      } catch { /* ignore */ }
      this.cline = null;
    }
    this.activeSessionIds.clear();
    this.sessionMeta.clear();
  }

  /** 列出活跃 session */
  listActiveSessions(): string[] {
    return Array.from(this.activeSessionIds);
  }
}

export const clineRuntime = new ClineRuntimeManager();