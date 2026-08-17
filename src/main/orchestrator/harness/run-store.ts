import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../vendors/types";
import { INITIAL_HARNESS_CACHE_STATE, type AgentState, type HarnessCacheState, type SideEffectKind } from "./types";
import type { ToolOutputRef } from "./tool-output/tool-output-store";

const ROOT_DIR_NAME = "cyrene-runs";
const SESSIONS_DIR_NAME = "sessions";
const INDEX_FILE_NAME = "index.json";
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
 * 主 Harness 的可恢复运行存储。使用既有 JSON + 原子 rename 方案，避免引入第二套数据库。
 */
export class HarnessRunStore {
  private readonly root: string;
  private readonly sessionsDir: string;
  private readonly indexPath: string;
  private readonly now: () => number;
  private index = new Map<string, IndexRow>();

  constructor(userDataRoot: string, options: HarnessRunStoreOptions = {}) {
    this.root = path.join(userDataRoot, ROOT_DIR_NAME);
    this.sessionsDir = path.join(this.root, SESSIONS_DIR_NAME);
    this.indexPath = path.join(this.root, INDEX_FILE_NAME);
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
    this.write(session);
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
    if (patch.messages !== undefined) session.messages = clone(patch.messages);
    if (patch.state !== undefined) session.state = clone(patch.state);
    if (patch.todoItems !== undefined) session.state.todoItems = clone(patch.todoItems);
    if (patch.toolOutputs !== undefined) session.toolOutputs = clone(patch.toolOutputs);
    if (patch.rounds !== undefined) session.rounds = patch.rounds;
    if (patch.cache !== undefined) session.cache = clone(patch.cache);
    if (patch.request !== undefined) session.request = clone(patch.request);
    session.updatedAt = this.now();
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
    this.write(session);
    this.appendEvent(session, `run_${status}`);
    return clone(session);
  }

  deleteConversation(conversationId: string): void {
    const rows = [...this.index.values()].filter((row) => row.conversationId === conversationId);
    for (const row of rows) {
      const file = this.sessionPath(row.runId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
      const events = this.eventPath(row.runId);
      if (fs.existsSync(events)) fs.unlinkSync(events);
      this.index.delete(row.runId);
    }
    this.writeIndex();
  }

  private initialize(): void {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.readIndex();
    let changed = false;
    for (const row of this.index.values()) {
      const session = this.read(row.runId);
      if (!session || session.status !== "running") continue;
      session.status = "interrupted";
      session.updatedAt = this.now();
      this.write(session);
      this.appendEvent(session, "run_interrupted");
      changed = true;
    }
    if (changed) this.writeIndex();
  }

  private require(runId: string): HarnessRunSession {
    const session = this.read(runId);
    if (!session) throw new Error("HARNESS_RUN_NOT_FOUND");
    return session;
  }

  private read(runId: string): HarnessRunSession | null {
    if (!validRunId(runId)) return null;
    const file = this.sessionPath(runId);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!isSession(parsed)) return null;
      return {
        ...parsed,
        cache: isCacheState(parsed.cache) ? parsed.cache : { ...INITIAL_HARNESS_CACHE_STATE },
      };
    } catch {
      return null;
    }
  }

  private write(session: HarnessRunSession): void {
    this.atomicWrite(this.sessionPath(session.runId), session);
    this.index.set(session.runId, {
      conversationId: session.conversationId,
      runId: session.runId,
      status: session.status,
      updatedAt: session.updatedAt,
    });
    this.writeIndex();
  }

  private readIndex(): void {
    if (!fs.existsSync(this.indexPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const row of parsed) {
        if (!row || typeof row !== "object") continue;
        const candidate = row as Partial<IndexRow>;
        if (typeof candidate.conversationId !== "string" || typeof candidate.runId !== "string"
          || !validRunId(candidate.runId) || !isRunStatus(candidate.status) || typeof candidate.updatedAt !== "number") continue;
        this.index.set(candidate.runId, candidate as IndexRow);
      }
    } catch {
      this.index.clear();
    }
  }

  private writeIndex(): void {
    this.atomicWrite(this.indexPath, [...this.index.values()]);
  }

  private appendEvent(session: HarnessRunSession, type: string, data?: Record<string, unknown>): void {
    fs.appendFileSync(this.eventPath(session.runId), `${JSON.stringify({ at: session.updatedAt, type, ...data })}\n`, "utf8");
  }

  private sessionPath(runId: string): string {
    return path.join(this.sessionsDir, `${runId}.json`);
  }

  private eventPath(runId: string): string {
    return path.join(this.sessionsDir, `${runId}.events.jsonl`);
  }

  private atomicWrite(file: string, value: unknown): void {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
  }
}

/** 同一 Electron 进程每个 userData 根只初始化一次，避免并行 Run 被误判为重启中断。 */
const sharedStores = new Map<string, HarnessRunStore>();

export function getHarnessRunStore(userDataRoot: string): HarnessRunStore {
  const key = path.resolve(userDataRoot);
  let store = sharedStores.get(key);
  if (!store) {
    store = new HarnessRunStore(key);
    sharedStores.set(key, store);
  }
  return store;
}
