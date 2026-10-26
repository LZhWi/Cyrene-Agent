import { randomUUID } from "node:crypto";
import { getServiceState, type ServiceState } from '../storage/service-state';
import type {
  TaskSession,
  TaskSessionStatus,
  TaskSubagentType,
  TodoItem,
  TodoStatus,
  TaskTraceRecord,
  TaskTranscriptMessage,
} from "../../shared/task-session";

const TRACE_LIMIT = 2_000;

export interface CreateTaskSessionInput {
  parentConversationId: string;
  parentRunId: string;
  description: string;
  prompt: string;
  subagentType: TaskSubagentType;
  mode: "work" | "code";
  resolvedWorkspaceRoot?: string;
}

export interface ResumeTaskSessionInput {
  parentConversationId: string;
  parentRunId: string;
  subagentType: TaskSubagentType;
  prompt: string;
}

export interface TaskSessionCheckpoint {
  parentRunId?: string;
  childRunId?: string;
  status?: TaskSessionStatus;
  messages?: TaskTranscriptMessage[];
  trace?: TaskTraceRecord[];
  todoItems?: TodoItem[];
  resultText?: string;
  error?: { code: string; message: string };
  completedAt?: number;
}

export interface TaskSessionStoreOptions {
  now?: () => number;
  createId?: () => string;
  createChildRunId?: () => string;
}

interface TaskSessionIndexRow {
  id: string;
  parentConversationId: string;
  status: TaskSessionStatus;
  updatedAt: number;
}

function isTaskStatus(value: unknown): value is TaskSessionStatus {
  return value === "running" || value === "completed" || value === "failed"
    || value === "cancelled" || value === "interrupted";
}

function isTaskType(value: unknown): value is TaskSubagentType {
  return value === "general" || value === "document" || value === "search";
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled";
}

function cloneTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<TodoItem>;
    if (typeof candidate.id !== "string" || candidate.id.trim().length === 0
      || typeof candidate.content !== "string" || candidate.content.trim().length === 0
      || !isTodoStatus(candidate.status)) return [];
    return [{
      id: candidate.id,
      content: candidate.content,
      status: candidate.status,
      ...(typeof candidate.activeForm === "string" ? { activeForm: candidate.activeForm } : {}),
    }];
  });
}

function isTaskSession(value: unknown): value is TaskSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<TaskSession>;
  return session.schemaVersion === 1
    && typeof session.id === "string"
    && typeof session.parentConversationId === "string"
    && typeof session.parentRunId === "string"
    && typeof session.childRunId === "string"
    && typeof session.description === "string"
    && isTaskType(session.subagentType)
    && (session.mode === "work" || session.mode === "code")
    && isTaskStatus(session.status)
    && Array.isArray(session.messages)
    && Array.isArray(session.trace)
    && typeof session.createdAt === "number"
    && typeof session.updatedAt === "number";
}

function cloneSession(session: TaskSession): TaskSession {
  return JSON.parse(JSON.stringify(session)) as TaskSession;
}
function taskState(root: string): ServiceState { return getServiceState(root,'tasks'); }

/** Inspector reads must not run startup recovery or mutate a running task. */
export function readTaskSession(root: string, taskId: string): TaskSession | null {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) return null;
  const sql=taskState(root);const value=sql.get(taskId);return isTaskSession(value)&&value.id===taskId?{...value,todoItems:cloneTodoItems(value.todoItems)}:null;
}

/**
 * Task 私有会话存储。它不依赖 Electron，方便测试；生产启动时传入 app.getPath("userData")。
 */
export class TaskSessionStore {
  private readonly sql: ServiceState;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createChildRunId: () => string;
  private index = new Map<string, TaskSessionIndexRow>();

  constructor(root: string, options: TaskSessionStoreOptions = {}) {
    this.sql=taskState(root);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.createChildRunId = options.createChildRunId ?? randomUUID;
    this.initialize();
  }

  create(input: CreateTaskSessionInput): TaskSession {
    const now = this.now();
    const session: TaskSession = {
      schemaVersion: 1,
      id: this.createId(),
      parentConversationId: input.parentConversationId,
      parentRunId: input.parentRunId,
      childRunId: this.createChildRunId(),
      description: input.description,
      subagentType: input.subagentType,
      mode: input.mode,
      ...(input.resolvedWorkspaceRoot ? { resolvedWorkspaceRoot: input.resolvedWorkspaceRoot } : {}),
      status: "running",
      messages: [{ role: "user", content: input.prompt }],
      trace: [],
      todoItems: [],
      createdAt: now,
      updatedAt: now,
    };
    this.write(session);
    return cloneSession(session);
  }

  get(taskId: string): TaskSession | null {
    const session = this.read(taskId);
    return session ? cloneSession(session) : null;
  }

  listForParent(parentConversationId: string): TaskSession[] {
    return [...this.index.values()]
      .filter((row) => row.parentConversationId === parentConversationId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .flatMap((row) => {
        const session = this.read(row.id);
        return session ? [cloneSession(session)] : [];
      });
  }

  resume(taskId: string, input: ResumeTaskSessionInput): TaskSession {
    const session = this.require(taskId);
    if (session.parentConversationId !== input.parentConversationId) {
      throw new Error("TASK_PARENT_MISMATCH");
    }
    if (session.subagentType !== input.subagentType) {
      throw new Error("TASK_PROFILE_MISMATCH");
    }
    if (session.status === "running") {
      throw new Error("TASK_ALREADY_RUNNING");
    }

    session.parentRunId = input.parentRunId;
    session.childRunId = this.createChildRunId();
    session.status = "running";
    session.resultText = undefined;
    session.error = undefined;
    session.completedAt = undefined;
    session.messages.push({ role: "user", content: input.prompt });
    session.updatedAt = this.now();
    this.write(session);
    return cloneSession(session);
  }

  checkpoint(taskId: string, patch: TaskSessionCheckpoint): TaskSession {
    const session = this.require(taskId);
    if (patch.parentRunId !== undefined) session.parentRunId = patch.parentRunId;
    if (patch.childRunId !== undefined) session.childRunId = patch.childRunId;
    if (patch.status !== undefined) session.status = patch.status;
    if (patch.messages !== undefined) session.messages = cloneSession({ ...session, messages: patch.messages }).messages;
    if (patch.trace !== undefined) session.trace = patch.trace.slice(-TRACE_LIMIT);
    if (patch.todoItems !== undefined) session.todoItems = cloneTodoItems(patch.todoItems);
    if (patch.resultText !== undefined) session.resultText = patch.resultText;
    if (patch.error !== undefined) session.error = { ...patch.error };
    if (patch.completedAt !== undefined) session.completedAt = patch.completedAt;
    session.updatedAt = this.now();
    this.write(session);
    return cloneSession(session);
  }

  private initialize(): void {
    this.readIndex();

    for (const row of this.index.values()) {
      const session = this.read(row.id);
      if (!session) continue;
      if (session.status === "running") {
        session.status = "interrupted";
        session.updatedAt = this.now();
        this.writeSession(session);
        this.index.set(session.id, this.indexRow(session));
      }
    }
  }

  private require(taskId: string): TaskSession {
    const session = this.read(taskId);
    if (!session) throw new Error("TASK_NOT_FOUND");
    return session;
  }

  private read(taskId: string): TaskSession | null {
    if(this.sql){const value=this.sql.get(taskId);return isTaskSession(value)?{...value,todoItems:cloneTodoItems(value.todoItems)}:null;}
    return null;
  }

  private write(session: TaskSession): void {
    this.writeSession(session);
    this.index.set(session.id, this.indexRow(session));
  }

  private writeSession(session: TaskSession): void {
    if(this.sql){this.sql.set(session.id,session);return;}

  }

  private readIndex(): void {
    if(this.sql){for(const s of Object.values(this.sql.all()) as TaskSession[])this.index.set(s.id,this.indexRow(s));return;}
  }

  private indexRow(session: TaskSession): TaskSessionIndexRow {
    return {
      id: session.id,
      parentConversationId: session.parentConversationId,
      status: session.status,
      updatedAt: session.updatedAt,
    };
  }


}
