import { app, shell } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type {
  WorkArtifact,
  WorkMessage,
  WorkPlan,
  WorkSession,
  WorkSessionMeta,
  WorkSessionMode,
} from "../../shared/work-types";

const ROOT_DIR_NAME = "cyrene-work";
const SESSIONS_DIR_NAME = "sessions";
const INDEX_FILE_NAME = "index.json";

let rootDir = "";
let sessionsDir = "";
let indexPath = "";
let indexCache: WorkSessionMeta[] = [];

function atomicWriteJson(filePath: string, value: unknown): void {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}
function ensureInitialized(): void {
  if (rootDir) return;
  rootDir = path.join(app.getPath("userData"), ROOT_DIR_NAME);
  sessionsDir = path.join(rootDir, SESSIONS_DIR_NAME);
  indexPath = path.join(rootDir, INDEX_FILE_NAME);
  fs.mkdirSync(sessionsDir, { recursive: true });
  try {
    const parsed = fs.existsSync(indexPath)
      ? JSON.parse(fs.readFileSync(indexPath, "utf8")) as unknown
      : [];
    indexCache = Array.isArray(parsed)
      ? parsed.filter(isWorkSessionMeta).sort((a, b) => b.updatedAt - a.updatedAt)
      : [];
  } catch {
    indexCache = [];
  }
}

function isWorkSessionMeta(value: unknown): value is WorkSessionMeta {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkSessionMeta>;
  return typeof item.id === "string"
    && typeof item.title === "string"
    && typeof item.messageCount === "number"
    && typeof item.createdAt === "number"
    && typeof item.updatedAt === "number";
}

function sessionPath(id: string): string {
  ensureInitialized();
  return path.join(sessionsDir, `${id}.json`);
}

/** 旧会话 JSON 无 mode 字段，缺省视为普通工作会话。 */
export function workSessionMode(session: WorkSession): WorkSessionMode {
  return session.mode === "code" || session.mode === "learn" ? session.mode : "work";
}

function metaFromSession(session: WorkSession): WorkSessionMeta {
  const mode = workSessionMode(session);
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    messageCount: session.messages.length,
    ...(mode !== "work" ? { mode } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function persistSession(session: WorkSession): void {
  ensureInitialized();
  atomicWriteJson(sessionPath(session.id), session);
  const meta = metaFromSession(session);
  const index = indexCache.findIndex((item) => item.id === session.id);
  if (index >= 0) indexCache[index] = meta;
  else indexCache.push(meta);
  indexCache.sort((a, b) => b.updatedAt - a.updatedAt);
  atomicWriteJson(indexPath, indexCache);
}

function deriveTitle(messages: WorkMessage[]): string {
  const first = messages.find((message) => message.role === "user" && message.content.trim());
  if (!first) return "新工作";
  const title = first.content.replace(/\s+/g, " ").trim();
  return title.length > 36 ? `${title.slice(0, 36)}…` : title;
}

export function initializeWorkStore(): void {
  ensureInitialized();
}

export function getWorkRootDir(): string {
  ensureInitialized();
  return rootDir;
}

export function listWorkSessions(): WorkSessionMeta[] {
  ensureInitialized();
  return indexCache.map((item) => ({ ...item }));
}

export function getWorkSession(id: string): WorkSession | null {
  const filePath = sessionPath(id);
  if (!fs.existsSync(filePath)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkSession;
    return session?.schemaVersion === 1 && Array.isArray(session.messages) ? session : null;
  } catch {
    return null;
  }
}

export function createWorkSession(
  title?: string,
  mode?: WorkSessionMode,
  boundDir?: string,
): WorkSession {
  const now = Date.now();
  const normalizedMode = mode === "code" || mode === "learn" ? mode : "work";
  const session: WorkSession = {
    schemaVersion: 1,
    id: randomUUID(),
    title: title?.trim() || (normalizedMode === "code" ? "新代码会话" : normalizedMode === "learn" ? "新学习会话" : "新工作"),
    messages: [],
    artifacts: [],
    status: "idle",
    ...(normalizedMode !== "work" ? { mode: normalizedMode } : {}),
    ...(normalizedMode !== "work" && boundDir ? { boundDir } : {}),
    createdAt: now,
    updatedAt: now,
  };
  persistSession(session);
  return session;
}

const DEFAULT_SESSION_TITLES = new Set(["新工作", "新代码会话", "新学习会话"]);

export function saveWorkSession(session: WorkSession): WorkSession {
  const next: WorkSession = {
    ...session,
    title: DEFAULT_SESSION_TITLES.has(session.title) ? deriveTitle(session.messages) : session.title,
    updatedAt: Date.now(),
  };
  persistSession(next);
  return next;
}

export function appendWorkMessage(id: string, message: WorkMessage): WorkSession | null {
  const session = getWorkSession(id);
  if (!session) return null;
  session.messages.push(message);
  return saveWorkSession(session);
}

export function updateWorkExecutionState(
  id: string,
  update: { status?: WorkSession["status"]; plan?: WorkPlan; artifacts?: WorkArtifact[] },
): WorkSession | null {
  const session = getWorkSession(id);
  if (!session) return null;
  if (update.status) session.status = update.status;
  if (update.plan) session.plan = update.plan;
  if (update.artifacts) session.artifacts = update.artifacts;
  return saveWorkSession(session);
}

export function renameWorkSession(id: string, title: string): WorkSession | null {
  const session = getWorkSession(id);
  if (!session || !title.trim()) return null;
  session.title = title.trim();
  return saveWorkSession(session);
}

export function deleteWorkSession(id: string): boolean {
  const filePath = sessionPath(id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const before = indexCache.length;
  indexCache = indexCache.filter((item) => item.id !== id);
  if (before !== indexCache.length) atomicWriteJson(indexPath, indexCache);
  return before !== indexCache.length;
}

export async function openWorkFolder(): Promise<void> {
  ensureInitialized();
  await shell.openPath(rootDir);
}
