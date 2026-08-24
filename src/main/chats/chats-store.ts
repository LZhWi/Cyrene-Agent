// 聊天会话持久化存储
//
// 布局：<userData>/cyrene-chats/
//   index.json              — ChatSessionMeta[]，按 updatedAt desc 排序
//   sessions/<id>.json      — 完整 ChatSession（含 messages）
//
// 设计：
// - 列表读 index.json（轻），进入会话才读 sessions/<id>.json（重）；
// - 写时先写 .tmp 再 rename，避免 crash 中间态损坏文件；
// - index.json 在内存里有缓存（initialize() 时一次性加载），
//   后续 list 直接返回缓存的 deep clone；任何写操作后同步刷新缓存；
// - 删除文件夹整体可移植：用户拷贝 cyrene-chats/ 到新机器即可恢复。

import { app, shell } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  CHAT_SCHEMA_VERSION,
  type ChatIndexRecoveryResult,
  type ChatMessage,
  type ChatSession,
  type ChatSessionMeta,
  type ChatSessionPurpose,
  type ChatSessionRecoveryResult,
  type ChatStorageStatus,
} from "../../shared/chat-types";
import { writeJsonAtomicSync } from "../runtime/atomic-file";

const ROOT_DIR_NAME = "cyrene-chats";
const SESSIONS_SUBDIR = "sessions";
const INDEX_FILE = "index.json";
const INDEX_LAST_GOOD_FILE = "index.last-good.json";
const RECOVERY_SUBDIR = "recovery";

let rootDir = "";
let sessionsDir = "";
let indexPath = "";
let indexLastGoodPath = "";
let recoveryDir = "";
let indexCache: ChatSessionMeta[] = [];
const SESSION_CACHE_CAPACITY = 8;
const sessionCache = new Map<string, ChatSession>();
let initialized = false;
let storageStatus: ChatStorageStatus = { status: "ready" };
const storageStatusListeners = new Set<(status: ChatStorageStatus) => void>();

type SessionRecoverySource = "legacy_tmp" | "last_good";
interface SessionInspection {
  primary: ChatSession | null;
  candidate: ChatSession | null;
  recoverySource: SessionRecoverySource | null;
  hasAnyFile: boolean;
}
const pendingSessionRecoveries = new Map<string, true>();

type IndexReadResult =
  | { status: "valid"; entries: ChatSessionMeta[] }
  | { status: "missing"; error: string }
  | { status: "invalid"; error: string };

function cloneSession(session: ChatSession): ChatSession {
  return structuredClone(session);
}

function setStorageStatus(status: ChatStorageStatus): void {
  storageStatus = status;
  for (const listener of storageStatusListeners) {
    try { listener(getStorageStatus()); } catch { /* status observers must not break storage */ }
  }
}

function rememberSession(session: ChatSession): void {
  sessionCache.delete(session.id);
  sessionCache.set(session.id, cloneSession(session));
  while (sessionCache.size > SESSION_CACHE_CAPACITY) {
    const oldestId = sessionCache.keys().next().value;
    if (oldestId === undefined) break;
    sessionCache.delete(oldestId);
  }
}

function ensureDirs(): void {
  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
}

function isValidMessage(message: unknown): message is ChatMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<ChatMessage>;
  return typeof candidate.id === "string"
    && (candidate.role === "user" || candidate.role === "model")
    && typeof candidate.content === "string"
    && typeof candidate.at === "number"
    && Number.isFinite(candidate.at);
}

function normalizeSession(value: unknown, expectedId?: string): ChatSession | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Partial<ChatSession>;
  if (session.schemaVersion !== CHAT_SCHEMA_VERSION) return null;
  if (typeof session.id !== "string" || !session.id || (expectedId && session.id !== expectedId)) return null;
  if (typeof session.title !== "string") return null;
  if (!(session.identityId === null || typeof session.identityId === "string")) return null;
  if (typeof session.createdAt !== "number" || !Number.isFinite(session.createdAt)) return null;
  if (typeof session.updatedAt !== "number" || !Number.isFinite(session.updatedAt)) return null;
  if (!Array.isArray(session.messages) || !session.messages.every(isValidMessage)) return null;
  if (session.purpose !== undefined && session.purpose !== "proactive-chat") return null;
  return session as ChatSession;
}

function normalizeMeta(value: unknown): ChatSessionMeta | null {
  if (!value || typeof value !== "object") return null;
  const meta = value as Partial<ChatSessionMeta>;
  if (typeof meta.id !== "string" || !meta.id) return null;
  if (typeof meta.title !== "string") return null;
  if (!(meta.identityId === undefined || meta.identityId === null || typeof meta.identityId === "string")) return null;
  if (typeof meta.createdAt !== "number" || !Number.isFinite(meta.createdAt)) return null;
  if (typeof meta.updatedAt !== "number" || !Number.isFinite(meta.updatedAt)) return null;
  if (typeof meta.messageCount !== "number" || !Number.isInteger(meta.messageCount) || meta.messageCount < 0) return null;
  if (meta.purpose !== undefined && meta.purpose !== "proactive-chat") return null;
  return { ...meta, identityId: meta.identityId ?? null } as ChatSessionMeta;
}

function readIndexFile(filePath: string): IndexReadResult {
  if (!fs.existsSync(filePath)) return { status: "missing", error: `${path.basename(filePath)} 不存在` };
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { status: "invalid", error: `${path.basename(filePath)} 根节点不是数组` };
    const entries: ChatSessionMeta[] = [];
    const ids = new Set<string>();
    for (const item of parsed) {
      const meta = normalizeMeta(item);
      if (!meta) return { status: "invalid", error: `${path.basename(filePath)} 包含非法索引项` };
      if (ids.has(meta.id)) return { status: "invalid", error: `${path.basename(filePath)} 包含重复会话 ID` };
      ids.add(meta.id);
      entries.push(meta);
    }
    return { status: "valid", entries };
  } catch (err) {
    return { status: "invalid", error: err instanceof Error ? err.message : String(err) };
  }
}

function persistIndex(): void {
  // 排序按 updatedAt desc，最近的对话排前面
  indexCache.sort((a, b) => b.updatedAt - a.updatedAt);
  writeJsonAtomicSync(indexLastGoodPath, indexCache);
  writeJsonAtomicSync(indexPath, indexCache);
}

function sessionPath(id: string): string {
  return path.join(sessionsDir, id + ".json");
}

function sessionLastGoodPath(id: string): string {
  return path.join(sessionsDir, id + ".last-good.json");
}

function moveCorruptSessionFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const targetDir = path.join(recoveryDir, "sessions");
  fs.mkdirSync(targetDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(targetDir, `${path.basename(filePath, ".json")}.corrupt.${timestamp}.json`);
  fs.renameSync(filePath, target);
  return target;
}

function readValidSessionCandidate(filePath: string, id: string): ChatSession | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return normalizeSession(JSON.parse(fs.readFileSync(filePath, "utf8")), id);
  } catch {
    return null;
  }
}

function inspectSessionFiles(id: string): SessionInspection {
  const filePath = sessionPath(id);
  const legacyTmpPath = filePath + ".tmp";
  const lastGoodPath = sessionLastGoodPath(id);
  const primary = readValidSessionCandidate(filePath, id);
  const legacyTmp = readValidSessionCandidate(legacyTmpPath, id);
  const lastGood = readValidSessionCandidate(lastGoodPath, id);
  return {
    primary,
    candidate: legacyTmp ?? lastGood,
    recoverySource: legacyTmp ? "legacy_tmp" : lastGood ? "last_good" : null,
    hasAnyFile: [filePath, legacyTmpPath, lastGoodPath].some((candidate) => fs.existsSync(candidate)),
  };
}

function queueSessionRecovery(id: string): void {
  pendingSessionRecoveries.set(id, true);
}

function activateNextSessionRecovery(): void {
  const sessionId = pendingSessionRecoveries.keys().next().value as string | undefined;
  if (!sessionId) {
    setStorageStatus({ status: "ready" });
    return;
  }
  const inspection = inspectSessionFiles(sessionId);
  setStorageStatus({
    status: "session_recovery_pending",
    sessionId,
    recoverable: Boolean(inspection.primary ?? inspection.candidate),
    recoverySource: inspection.primary ? null : inspection.recoverySource,
  });
}

function loadSessionFromDisk(id: string, expectedToExist = false): ChatSession | null {
  const inspection = inspectSessionFiles(id);
  if (inspection.primary) {
    const lastGoodPath = sessionLastGoodPath(id);
    const lastGood = readValidSessionCandidate(lastGoodPath, id);
    if (!lastGood || JSON.stringify(lastGood) !== JSON.stringify(inspection.primary)) {
      writeJsonAtomicSync(lastGoodPath, inspection.primary);
    }
    return inspection.primary;
  }
  if (inspection.hasAnyFile || expectedToExist) {
    queueSessionRecovery(id);
    activateNextSessionRecovery();
  }
  return null;
}

function readSessionFile(id: string): ChatSession | null {
  if (storageStatus.status !== "ready") return null;
  const cached = sessionCache.get(id);
  if (cached) {
    rememberSession(cached);
    return cloneSession(cached);
  }
  const session = loadSessionFromDisk(id, indexCache.some((meta) => meta.id === id));
  if (session) {
    rememberSession(session);
    const meta = metaFromSession(session);
    const currentMeta = indexCache.find((entry) => entry.id === id);
    if (!currentMeta || JSON.stringify(currentMeta) !== JSON.stringify(meta)) upsertMeta(meta);
    return session;
  }
  return null;
}

function writeSessionFile(session: ChatSession): void {
  if (!normalizeSession(session, session.id)) throw new Error("E_INVALID_CHAT_SESSION");
  writeJsonAtomicSync(sessionLastGoodPath(session.id), session);
  writeJsonAtomicSync(sessionPath(session.id), session);
  rememberSession(session);
}

function metaFromSession(session: ChatSession): ChatSessionMeta {
  return {
    id: session.id,
    title: session.title,
    identityId: session.identityId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    purpose: session.purpose,
  };
}

function upsertMeta(meta: ChatSessionMeta): void {
  const idx = indexCache.findIndex((m) => m.id === meta.id);
  if (idx === -1) indexCache.push(meta);
  else indexCache[idx] = meta;
  persistIndex();
}

function removeMetaById(id: string): void {
  indexCache = indexCache.filter((m) => m.id !== id);
  persistIndex();
}

function listSessionJsonFiles(): string[] {
  return fs.readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".last-good.json"))
    .sort();
}

function indexNeedsRebuild(entries: ChatSessionMeta[], sourcePath: string): boolean {
  const files = listSessionJsonFiles();
  const fileIds = new Set(files.map((name) => name.slice(0, -".json".length)));
  const indexIds = new Set(entries.map((entry) => entry.id));
  if (fileIds.size !== indexIds.size) return true;
  for (const id of fileIds) if (!indexIds.has(id)) return true;
  const indexMtime = fs.existsSync(sourcePath) ? fs.statSync(sourcePath).mtimeMs : 0;
  return files.some((name) => fs.statSync(path.join(sessionsDir, name)).mtimeMs > indexMtime);
}

function rebuildIndexFromSessions(expectedEntries: ChatSessionMeta[] = []): { entries: ChatSessionMeta[]; invalidSessions: string[] } {
  const entries: ChatSessionMeta[] = [];
  const invalidSessions: string[] = [];
  const seenIds = new Set<string>();
  for (const name of listSessionJsonFiles()) {
    const id = name.slice(0, -".json".length);
    seenIds.add(id);
    const inspection = inspectSessionFiles(id);
    if (!inspection.primary) {
      queueSessionRecovery(id);
      invalidSessions.push(name);
      continue;
    }
    const lastGood = readValidSessionCandidate(sessionLastGoodPath(id), id);
    if (!lastGood || JSON.stringify(lastGood) !== JSON.stringify(inspection.primary)) {
      writeJsonAtomicSync(sessionLastGoodPath(id), inspection.primary);
    }
    entries.push(metaFromSession(inspection.primary));
  }
  for (const expected of expectedEntries) {
    if (seenIds.has(expected.id)) continue;
    queueSessionRecovery(expected.id);
    invalidSessions.push(`${expected.id}.json`);
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return { entries, invalidSessions };
}

function backupIndexFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  fs.mkdirSync(recoveryDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(recoveryDir, `${path.basename(filePath, ".json")}.corrupt.${timestamp}.json`);
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function requireWritable(): void {
  if (storageStatus.status !== "ready") {
    throw new Error(`E_CHAT_STORAGE_NOT_READY: ${storageStatus.status}`);
  }
}

// 从首条用户消息推导标题（前 30 字 / 单行）。
function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  if (!firstUser) return "新对话";
  const cleaned = firstUser.content.replace(/\s+/g, " ").trim();
  return cleaned.length > 30 ? cleaned.slice(0, 30) + "…" : cleaned;
}

// ── public API ──────────────────────────────────────────────

export function initialize(): void {
  if (initialized) return;
  rootDir = path.join(app.getPath("userData"), ROOT_DIR_NAME);
  sessionsDir = path.join(rootDir, SESSIONS_SUBDIR);
  indexPath = path.join(rootDir, INDEX_FILE);
  indexLastGoodPath = path.join(rootDir, INDEX_LAST_GOOD_FILE);
  recoveryDir = path.join(rootDir, RECOVERY_SUBDIR);
  ensureDirs();
  const primary = readIndexFile(indexPath);
  const lastGood = readIndexFile(indexLastGoodPath);
  const sessionFiles = listSessionJsonFiles();

  if (primary.status === "valid") {
    indexCache = primary.entries;
    if (indexNeedsRebuild(indexCache, indexPath)) {
      const rebuilt = rebuildIndexFromSessions(indexCache);
      if (pendingSessionRecoveries.size === 0) {
        indexCache = rebuilt.entries;
        persistIndex();
      }
    } else if (lastGood.status !== "valid" || JSON.stringify(lastGood.entries) !== JSON.stringify(indexCache)) {
      writeJsonAtomicSync(indexLastGoodPath, indexCache);
    }
    if (pendingSessionRecoveries.size > 0) activateNextSessionRecovery();
    else setStorageStatus({ status: "ready" });
  } else if (lastGood.status === "valid") {
    indexCache = lastGood.entries;
    if (indexNeedsRebuild(indexCache, indexLastGoodPath)) rebuildIndexFromSessions(indexCache);
    persistIndex();
    if (pendingSessionRecoveries.size > 0) activateNextSessionRecovery();
    else setStorageStatus({ status: "ready" });
  } else if (sessionFiles.length === 0 && primary.status === "missing" && lastGood.status === "missing") {
    indexCache = [];
    setStorageStatus({ status: "ready" });
    persistIndex();
  } else {
    indexCache = [];
    setStorageStatus({
      status: "recovery_pending",
      primaryError: primary.error,
      lastGoodError: lastGood.error,
    });
  }
  sessionCache.clear();
  initialized = true;
}

export function getStorageStatus(): ChatStorageStatus {
  return { ...storageStatus };
}

export function onStorageStatusChanged(listener: (status: ChatStorageStatus) => void): () => void {
  storageStatusListeners.add(listener);
  return () => storageStatusListeners.delete(listener);
}

export function approveIndexRebuild(): ChatIndexRecoveryResult {
  if (
    storageStatus.status !== "recovery_pending"
    && !(storageStatus.status === "recovery_failed" && storageStatus.recovery === "index")
  ) {
    return { ok: storageStatus.status === "ready", recoveredSessions: indexCache.length, invalidSessions: [], backupPaths: [] };
  }
  setStorageStatus({ status: "rebuilding", recovery: "index" });
  const backupPaths: string[] = [];
  try {
    for (const filePath of [indexPath, indexLastGoodPath]) {
      const backupPath = backupIndexFile(filePath);
      if (backupPath) backupPaths.push(backupPath);
    }
    const rebuilt = rebuildIndexFromSessions();
    indexCache = rebuilt.entries;
    persistIndex();
    sessionCache.clear();
    if (pendingSessionRecoveries.size > 0) activateNextSessionRecovery();
    else setStorageStatus({ status: "ready" });
    return {
      ok: true,
      recoveredSessions: indexCache.length,
      invalidSessions: rebuilt.invalidSessions,
      backupPaths,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    setStorageStatus({ status: "recovery_failed", recovery: "index", error });
    return { ok: false, recoveredSessions: 0, invalidSessions: [], backupPaths, error };
  }
}

export function approveSessionRecovery(): ChatSessionRecoveryResult {
  const sessionId = storageStatus.status === "session_recovery_pending"
    ? storageStatus.sessionId
    : storageStatus.status === "recovery_failed" && storageStatus.recovery === "session"
      ? storageStatus.sessionId
      : undefined;
  if (!sessionId || !pendingSessionRecoveries.has(sessionId)) {
    return { ok: false, sessionId: sessionId ?? "", backupPaths: [], error: "没有等待批准的 session 恢复" };
  }

  setStorageStatus({ status: "rebuilding", recovery: "session", sessionId });
  const backupPaths: string[] = [];
  try {
    const filePath = sessionPath(sessionId);
    const legacyTmpPath = filePath + ".tmp";
    const lastGoodPath = sessionLastGoodPath(sessionId);
    const inspection = inspectSessionFiles(sessionId);
    let action: "recovered" | "isolated";
    let recoverySource: "primary" | "legacy_tmp" | "last_good" | undefined;

    if (inspection.primary) {
      writeJsonAtomicSync(lastGoodPath, inspection.primary);
      rememberSession(inspection.primary);
      action = "recovered";
      recoverySource = "primary";
    } else if (inspection.candidate && inspection.recoverySource) {
      const primaryBackup = moveCorruptSessionFile(filePath);
      if (primaryBackup) backupPaths.push(primaryBackup);
      if (inspection.recoverySource === "legacy_tmp") {
        const lastGoodBackup = moveCorruptSessionFile(lastGoodPath);
        if (lastGoodBackup) backupPaths.push(lastGoodBackup);
      } else {
        const legacyTmpBackup = moveCorruptSessionFile(legacyTmpPath);
        if (legacyTmpBackup) backupPaths.push(legacyTmpBackup);
      }
      writeJsonAtomicSync(lastGoodPath, inspection.candidate);
      writeJsonAtomicSync(filePath, inspection.candidate);
      if (fs.existsSync(legacyTmpPath)) fs.unlinkSync(legacyTmpPath);
      rememberSession(inspection.candidate);
      action = "recovered";
      recoverySource = inspection.recoverySource;
    } else {
      for (const candidatePath of [filePath, lastGoodPath, legacyTmpPath]) {
        const backupPath = moveCorruptSessionFile(candidatePath);
        if (backupPath) backupPaths.push(backupPath);
      }
      sessionCache.delete(sessionId);
      action = "isolated";
    }

    pendingSessionRecoveries.delete(sessionId);
    const expectedEntries = action === "isolated"
      ? indexCache.filter((entry) => entry.id !== sessionId)
      : indexCache;
    const rebuilt = rebuildIndexFromSessions(expectedEntries);
    if (pendingSessionRecoveries.size === 0) {
      indexCache = rebuilt.entries;
      persistIndex();
      setStorageStatus({ status: "ready" });
    } else {
      activateNextSessionRecovery();
    }
    return { ok: true, sessionId, action, recoverySource, backupPaths };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    setStorageStatus({ status: "recovery_failed", recovery: "session", sessionId, error });
    return { ok: false, sessionId, backupPaths, error };
  }
}

export function declineIndexRebuild(): ChatStorageStatus {
  return getStorageStatus();
}

export function getRootDir(): string {
  return rootDir;
}

export function listSessions(): ChatSessionMeta[] {
  // 返回深拷贝，避免外部修改影响缓存
  return indexCache.map((m) => ({ ...m }));
}

export function getSession(id: string): ChatSession | null {
  return readSessionFile(id);
}

export function getSessionPage(id: string, before: number | null, limit: number): {
  session: Omit<ChatSession, "messages"> & { messageCount: number };
  messages: ChatMessage[];
  hasMore: boolean;
} | null {
  const session = readSessionFile(id);
  if (!session) return null;
  const end = Math.max(0, Math.min(before ?? session.messages.length, session.messages.length));
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 1, 200));
  const start = Math.max(0, end - safeLimit);
  const { messages: _messages, ...meta } = session;
  return {
    session: { ...meta, messageCount: session.messages.length },
    messages: session.messages.slice(start, end),
    hasMore: start > 0,
  };
}

export function createSession(opts?: {
  title?: string;
  identityId?: string | null;
  initialMessages?: ChatMessage[];
  purpose?: ChatSessionPurpose;
}): ChatSession {
  requireWritable();
  const now = Date.now();
  const messages = opts?.initialMessages ?? [];
  const session: ChatSession = {
    id: randomUUID(),
    title: opts?.title?.trim() || (messages.length > 0 ? deriveTitle(messages) : "新对话"),
    identityId: opts?.identityId ?? null,
    messages,
    createdAt: now,
    updatedAt: now,
    schemaVersion: CHAT_SCHEMA_VERSION,
    purpose: opts?.purpose,
    titleIsCustom: opts?.purpose ? true : undefined,
  };
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function getSessionByPurpose(purpose: ChatSessionPurpose): ChatSession | null {
  const meta = indexCache.find((session) => session.purpose === purpose);
  return meta ? readSessionFile(meta.id) : null;
}

/**
 * Electron 主进程内的 store API 是同步的：查询与创建之间没有 await，
 * 因此同一事件循环上的并发调用也无法穿插出两个同用途会话。
 */
export function getOrCreateSessionByPurpose(
  purpose: ChatSessionPurpose,
  opts?: { title?: string; identityId?: string | null },
): ChatSession {
  const existing = getSessionByPurpose(purpose);
  if (existing) return existing;
  return createSession({
    title: opts?.title,
    identityId: opts?.identityId ?? null,
    purpose,
  });
}

export function appendMessage(id: string, message: ChatMessage): ChatSession | null {
  requireWritable();
  const session = readSessionFile(id);
  if (!session) return null;
  session.messages.push(message);
  session.updatedAt = Date.now();
  // 用户没手动改名时，根据最新内容重新派生（清空后也会回到"新对话"）
  if (!session.titleIsCustom) {
    session.title = deriveTitle(session.messages);
  }
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

// 批量覆盖整个 messages 数组（聊天窗口流式结束/清空/错误等场景用）。
// updatedAt 一并刷新；用户没手动改名时根据新内容重新派生。
export function replaceMessages(id: string, messages: ChatMessage[]): ChatSession | null {
  requireWritable();
  const session = readSessionFile(id);
  if (!session) return null;
  session.messages = messages;
  session.updatedAt = Date.now();
  if (!session.titleIsCustom) {
    session.title = deriveTitle(session.messages);
  }
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function replaceMessagesTail(id: string, startIndex: number, messages: ChatMessage[]): ChatSession | null {
  requireWritable();
  const session = readSessionFile(id);
  if (!session || !Number.isInteger(startIndex) || startIndex < 0 || startIndex > session.messages.length) return null;
  session.messages = session.messages.slice(0, startIndex).concat(messages);
  session.updatedAt = Date.now();
  if (!session.titleIsCustom) session.title = deriveTitle(session.messages);
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

/**
 * 删除一条消息及其配对（整轮）。
 * - 删除 AI(model) 消息时：如果前一条是 user 消息，一起删除
 * - 删除 user 消息时：如果后一条是 model 消息，一起删除
 * 用于清除 AI 越界生成等有问题的历史记录，避免污染上下文。
 */
export function deleteMessageRound(id: string, messageId: string): ChatSession | null {
  requireWritable();
  const session = readSessionFile(id);
  if (!session) return null;
  const index = session.messages.findIndex(m => m.id === messageId);
  if (index < 0) return null;

  let start = index;
  let end = index + 1;

  const target = session.messages[index];
  // 通话消息（callEvent 标记）是独立事件记录，不是对话轮次，删除时不连带相邻消息。
  if (target.callEvent) {
    // 只删通话消息本身
  } else if (target.role === "model" && index > 0 && session.messages[index - 1].role === "user") {
    start = index - 1;
  } else if (target.role === "user" && index + 1 < session.messages.length && session.messages[index + 1].role === "model") {
    end = index + 2;
  }

  session.messages.splice(start, end - start);
  session.updatedAt = Date.now();
  if (!session.titleIsCustom) session.title = deriveTitle(session.messages);
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function renameSession(id: string, title: string): ChatSession | null {
  requireWritable();
  const session = readSessionFile(id);
  if (!session) return null;
  const trimmed = title.trim();
  if (!trimmed) return session;
  session.title = trimmed.slice(0, 80);
  session.titleIsCustom = true;
  session.updatedAt = Date.now();
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function deleteSession(id: string): boolean {
  requireWritable();
  const filePath = sessionPath(id);
  let fileExisted = false;
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      fileExisted = true;
    } catch (err) {
      console.warn("[chats-store] 删除 session 文件失败:", id, err);
    }
  }
  for (const companionPath of [sessionLastGoodPath(id), filePath + ".tmp"]) {
    try {
      if (fs.existsSync(companionPath)) fs.unlinkSync(companionPath);
    } catch (err) {
      console.warn("[chats-store] 删除 session 恢复副本失败:", id, err);
    }
  }
  const inIndex = indexCache.some((m) => m.id === id);
  sessionCache.delete(id);
  if (inIndex) removeMetaById(id);
  return fileExisted || inIndex;
}

// 返回最新一条会话的 id（按 updatedAt 排）；列表为空返回 null。
export function getLatestSessionId(): string | null {
  if (indexCache.length === 0) return null;
  // indexCache 已按 updatedAt desc 持久化，但保险起见再排一次
  const sorted = [...indexCache].sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted[0].id;
}

// 一次性迁移：从聊天窗口 localStorage 拿来的旧 Message[] 包成单个 session。
// 已经迁移过（再次调用且数据相同）时返回 null 让调用方决定是否提示。
export function migrateLegacyMessages(messages: ChatMessage[]): ChatSession | null {
  requireWritable();
  if (!messages || messages.length === 0) return null;
  // 过滤掉无意义条目（空 content / 占位）
  const cleaned = messages.filter(
    (m) => m && (m.role === "user" || m.role === "model") && typeof m.content === "string" && m.content.trim(),
  );
  if (cleaned.length === 0) return null;
  return createSession({
    title: "历史对话",
    identityId: null,
    initialMessages: cleaned,
  });
}

// 在系统文件管理器中打开存储目录。
export async function openStorageFolder(): Promise<void> {
  ensureDirs();
  await shell.openPath(rootDir);
}
