import fs from "fs";
import path from "path";
import { getUserDataDir } from "../runtime/runtime-paths";
import { deleteChatImagesBySessionId, deleteHistoryEntriesBySessionId, getEntriesBySource } from "../rag";
import { getStorageStatus, listSessions } from "./chats-store";

function pendingFile(): string {
  return path.join(getUserDataDir(), "cyrene-chats", "pending-history-deletions.json");
}

function readPending(): string[] {
  const file = pendingFile();
  if (!fs.existsSync(file)) return [];
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id.length > 0)) {
    throw new Error("Invalid pending history deletions file");
  }
  return value;
}

function writePending(ids: string[]): void {
  const file = pendingFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ids), "utf8");
  fs.renameSync(tmp, file);
}

/** Persist the intent before deleting the session, so a crash cannot strand its RAG history. */
export function queueSessionHistoryDeletion(sessionId: string): void {
  const pending = readPending();
  if (!pending.includes(sessionId)) writePending([...pending, sessionId]);
}

/** Retry only explicitly queued deletions; never delete unrelated channel or legacy history. */
export function retrySessionHistoryDeletions(): void {
  if (getStorageStatus().status !== "ready") return;
  const active = new Set(listSessions().map((session) => session.id));
  const pending = readPending();
  if (pending.length === 0) return;
  const entries = [...getEntriesBySource("chat_history"), ...getEntriesBySource("chat_image")];
  const remaining: string[] = [];
  for (const id of pending) {
    if (active.has(id)) {
      remaining.push(id);
      continue;
    }
    const hasHistory = entries.some((entry) => {
      const metadata = entry.metadata;
      if (metadata?.sessionId === id) return true;
      return Array.isArray(metadata?.occurrences)
        && metadata.occurrences.some((item: unknown) => !!item && typeof item === "object" && (item as { sessionId?: unknown }).sessionId === id);
    });
    if (!hasHistory) continue; // Confirmed absent from the loaded, on-disk RAG snapshot.
    try {
      deleteHistoryEntriesBySessionId(id);
      deleteChatImagesBySessionId(id);
      // RAG writes are debounced. Keep the intent until a later startup confirms persistence.
      remaining.push(id);
    } catch (err) {
      remaining.push(id);
      console.warn("[Chats] 删除会话历史索引失败，下次启动重试:", id, err);
    }
  }
  if (remaining.length !== pending.length) writePending(remaining);
}

/** Audit old residuals without changing user data; channel histories are not desktop sessions. */
export function auditUnlinkedDesktopHistory(): void {
  if (getStorageStatus().status !== "ready") return;
  const active = new Set(listSessions().map((session) => session.id));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const missing = new Set<string>();
  for (const entry of getEntriesBySource("chat_history")) {
    const id = entry.metadata?.sessionId;
    if (typeof id === "string" && uuid.test(id) && !active.has(id)) missing.add(id);
  }
  if (missing.size > 0) console.warn(`[Chats] 检测到 ${missing.size} 个不在桌面会话列表的历史索引会话；仅报告，未自动清理。`);
}
