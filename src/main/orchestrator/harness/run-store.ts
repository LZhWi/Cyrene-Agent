import { requireStorageRuntime } from "../../storage/storage-backend";
import path from "node:path";
import type { ChatMessage } from "../vendors/types";
import { INITIAL_HARNESS_CACHE_STATE, type AgentState, type HarnessCacheState, type SideEffectKind } from "./types";
import type { ToolOutputRef } from "./tool-output/tool-output-store";

const SCHEMA_VERSION = 1;

export type HarnessRunStatus = "running" | "interrupted" | "completed" | "cancelled" | "failed";
export type PersistedToolCallStatus = "planned" | "started" | "committed" | "unknown" | "not_executed";

export interface HarnessRequestSnapshot {
  provider: string;
  model: string;
  contextWindowTokens: number;
  reasoning?: string;
  mode?: string;
  promptFingerprint: string;
  toolSchemaFingerprint: string;
  enabledToolIds?: string[];
  workspaceRoot?: string;
}

export interface PersistedToolCall {
  toolCallId: string;
  toolName: string;
  sideEffect: SideEffectKind;
  status: PersistedToolCallStatus;
  updatedAt: number;
}

export interface HarnessRunSession {
  schemaVersion: typeof SCHEMA_VERSION;
  conversationId: string;
  runId: string;
  status: HarnessRunStatus;
  messages: ChatMessage[];
  state: AgentState;
  toolOutputs: ToolOutputRef[];
  toolCalls: PersistedToolCall[];
  rounds: number;
  cache: HarnessCacheState;
  request: HarnessRequestSnapshot;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  resumedFromRunId?: string;
}

export interface CreateHarnessRunInput {
  conversationId: string;
  runId: string;
  messages: ChatMessage[];
  request: HarnessRequestSnapshot;
  state?: AgentState;
  cache?: HarnessCacheState;
  resumedFromRunId?: string;
}

export interface HarnessRunCheckpoint {
  messages?: ChatMessage[];
  state?: AgentState;
  todoItems?: AgentState["todoItems"];
  toolOutputs?: ToolOutputRef[];
  rounds?: number;
  cache?: HarnessCacheState;
  request?: HarnessRequestSnapshot;
}

export interface HarnessRunStoreOptions {
  now?: () => number;
}

interface IndexRow {
  conversationId: string;
  runId: string;
  status: HarnessRunStatus;
  updatedAt: number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validRunId(value: string): boolean {
  return value.length > 0 && !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function isRunStatus(value: unknown): value is HarnessRunStatus {
  return value === "running" || value === "interrupted" || value === "completed" || value === "cancelled" || value === "failed";
}

function isCacheState(value: unknown): value is HarnessCacheState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<HarnessCacheState>;
  return typeof candidate.cacheEpoch === "number" && Number.isInteger(candidate.cacheEpoch) && candidate.cacheEpoch > 0
    && (candidate.epochReason === "run_start" || candidate.epochReason === "compaction"
      || candidate.epochReason === "recovery" || candidate.epochReason === "model_changed"
      || candidate.epochReason === "tool_catalog_changed" || candidate.epochReason === "prompt_version_changed");
}

function isSession(value: unknown): value is HarnessRunSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<HarnessRunSession>;
  return candidate.schemaVersion === SCHEMA_VERSION
    && typeof candidate.conversationId === "string"
    && typeof candidate.runId === "string" && validRunId(candidate.runId)
    && isRunStatus(candidate.status)
    && Array.isArray(candidate.messages)
    && !!candidate.state && Array.isArray(candidate.state.todoItems) && Array.isArray(candidate.state.uncertainEffects)
    && Array.isArray(candidate.toolOutputs) && Array.isArray(candidate.toolCalls)
    && typeof candidate.rounds === "number"
    && (candidate.cache === undefined || isCacheState(candidate.cache))
    && !!candidate.request
    && typeof candidate.createdAt === "number" && typeof candidate.updatedAt === "number";
}

/**
 * 主 Harness 的可恢复运行存储，由统一 SQLite owner 保存。
 */
export class HarnessRunStore {
  private readonly backend: ReturnType<typeof requireStorageRuntime>;
  private pendingCheckpoint?: HarnessRunSession;
  private readonly now: () => number;
  private index = new Map<string, IndexRow>();
  private checkpointCount = 0;

  constructor(userDataRoot: string, options: HarnessRunStoreOptions = {}) {
    this.backend = requireStorageRuntime(userDataRoot);
    this.now = options.now ?? Date.now;
    this.initialize();
  }

  create(input: CreateHarnessRunInput): HarnessRunSession {
    if (!input.conversationId || !validRunId(input.runId)) throw new Error("HARNESS_RUN_INVALID_ID");
    // canonical runId 在生产中唯一；但旧终态/中断记录不可阻碍一次新的同名测试或迁移运行。
    // 仅仍在执行的记录代表真实冲突，绝不覆盖。
    if (this.get(input.runId)?.status === "running") throw new Error("HARNESS_RUN_EXISTS");
    const now = this.now();
    const session: HarnessRunSession = {
      schemaVersion: SCHEMA_VERSION,
      conversationId: input.conversationId,
      runId: input.runId,
      status: "running",
      messages: clone(input.messages),
      state: clone(input.state ?? { todoItems: [], uncertainEffects: [] }),
      toolOutputs: [],
      toolCalls: [],
      rounds: 0,
      cache: clone(input.cache ?? INITIAL_HARNESS_CACHE_STATE),
      request: clone(input.request),
      ...(input.resumedFromRunId ? { resumedFromRunId: input.resumedFromRunId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.write(session, "now");
    this.appendEvent(session, "run_created");
    return clone(session);
  }

  get(runId: string): HarnessRunSession | null {
    const session = this.read(runId);
    return session ? clone(session) : null;
  }

  getLatestInterrupted(conversationId: string): HarnessRunSession | null {
    const row = [...this.index.values()]
      .filter((candidate) => candidate.conversationId === conversationId && candidate.status === "interrupted")
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    return row ? this.get(row.runId) : null;
  }

  checkpoint(runId: string, patch: HarnessRunCheckpoint): HarnessRunSession {
    const session = this.require(runId);
    // 消费方克隆契约：harness 传活引用，这里在返回前同步 clone（问题 5 P0）
    if (patch.messages !== undefined) session.messages = clone(patch.messages);
    if (patch.state !== undefined) session.state = clone(patch.state);
    if (patch.todoItems !== undefined) session.state.todoItems = clone(patch.todoItems);
    if (patch.toolOutputs !== undefined) session.toolOutputs = clone(patch.toolOutputs);
    if (patch.rounds !== undefined) session.rounds = patch.rounds;
    if (patch.cache !== undefined) session.cache = clone(patch.cache);
    if (patch.request !== undefined) session.request = clone(patch.request);
    session.updatedAt = this.now();
    this.checkpointCount += 1;
    this.write(session);
    this.appendEvent(session, "checkpoint");
    return clone(session);
  }

  recordTool(runId: string, input: Omit<PersistedToolCall, "updatedAt">): HarnessRunSession {
    const session = this.require(runId);
    const updatedAt = this.now();
    const next: PersistedToolCall = { ...input, updatedAt };
    const existing = session.toolCalls.findIndex((call) => call.toolCallId === input.toolCallId);
    if (existing >= 0) session.toolCalls[existing] = next;
    else session.toolCalls.push(next);
    session.updatedAt = updatedAt;
    this.write(session);
    this.appendEvent(session, `tool_${input.status}`, { toolCallId: input.toolCallId });
    return clone(session);
  }

  recordCompaction(runId: string, input: { status: "started" | "committed"; messageCountBefore: number; messageCountAfter?: number }): void {
    const session = this.require(runId);
    this.appendEvent(session, `compaction_${input.status}`, {
      messageCountBefore: input.messageCountBefore,
      ...(input.messageCountAfter !== undefined ? { messageCountAfter: input.messageCountAfter } : {}),
    });
  }

  markTerminal(runId: string, status: Exclude<HarnessRunStatus, "running" | "interrupted">): HarnessRunSession {
    const session = this.require(runId);
    session.status = status;
    session.completedAt = this.now();
    session.updatedAt = session.completedAt;
    this.write(session, "now");
    this.appendEvent(session, `run_${status}`);
    console.log(`[HarnessRunStore] run=${runId} terminal=${status} checkpoints=${this.checkpointCount}`);
    return clone(session);
  }

  deleteConversation(conversationId: string): void {
    if (this.backend) { this.backend.call("harness.delete", conversationId); for (const [id,row] of this.index) if (row.conversationId === conversationId) this.index.delete(id); return; }
  }

  private initialize(): void {
    if (this.backend) {
      for (const value of this.backend.call("harness.all") as unknown[]) {
        if (!isSession(value)) continue;
        this.index.set(value.runId, { conversationId: value.conversationId, runId: value.runId, status: value.status, updatedAt: value.updatedAt });
        if (value.status === "running") { value.status = "interrupted"; value.updatedAt = this.now(); this.write(value); this.appendEvent(value, "run_interrupted"); }
      }
      return;
    }
  }

  private require(runId: string): HarnessRunSession {
    const session = this.read(runId);
    if (!session) throw new Error("HARNESS_RUN_NOT_FOUND");
    return session;
  }

  private read(runId: string): HarnessRunSession | null {
    if (!validRunId(runId)) return null;
    const value = this.backend.call("harness.get", runId); return isSession(value) ? { ...value, cache: isCacheState(value.cache) ? value.cache : { ...INITIAL_HARNESS_CACHE_STATE } } : null;
  }

  private write(session: HarnessRunSession, _mode: "now" | "lazy" = "lazy"): void {
    this.pendingCheckpoint = clone(session);
  }

  private appendEvent(session: HarnessRunSession, type: string, data?: Record<string, unknown>): void {
    if (this.backend) {
      const event = { at: session.updatedAt, type, ...data };
      const checkpoint = this.pendingCheckpoint;
      if (checkpoint) this.backend.call("harness.commit", checkpoint, event);
      else this.backend.call("harness.event", session.runId, event);
      this.pendingCheckpoint = undefined;
      this.index.set(session.runId, { conversationId: session.conversationId, runId: session.runId, status: session.status, updatedAt: session.updatedAt });
      return;
    }
  }
}

/** 同一 Electron 进程每个 userData 根只初始化一次，避免并行 Run 被误判为重启中断。 */
const sharedStores = new Map<string, HarnessRunStore>();

export function getHarnessRunStore(userDataRoot: string, conversationId?: string): HarnessRunStore {
  const key = path.resolve(userDataRoot);
  requireStorageRuntime(userDataRoot);

  const cacheKey = key;
  let store = sharedStores.get(cacheKey);
  if (!store) {
    store = new HarnessRunStore(key);
    sharedStores.set(cacheKey, store);
  }
  return store;
}
