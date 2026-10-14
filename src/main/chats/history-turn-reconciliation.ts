import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { getUserDataDir } from "../runtime/runtime-paths";
import {
  addHistoryMemory,
  deleteChatImagesByTurnIds,
  deleteHistoryEntriesByTurnIds,
  getEntriesBySource,
  isUserMemoryVectorStoreReady,
} from "../rag";
import { scheduleVisualHistoryIndex } from "../chat/visual-history-index";
import { getSession, getStorageStatus } from "./chats-store";
import { historyIndexText } from "./history-index-text";

interface PendingTurn { sessionId: string; turnId: string }
let running = false;
const queuedWhileRunning = new Set<string>();

function pendingFile(): string {
  return path.join(getUserDataDir(), "cyrene-chats", "pending-history-turns.json");
}

function readPending(): PendingTurn[] {
  const file = pendingFile();
  if (!fs.existsSync(file)) return [];
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(value) || !value.every((item) => item && typeof item.sessionId === "string"
    && typeof item.turnId === "string" && item.sessionId && item.turnId)) {
    throw new Error("Invalid pending history turns file");
  }
  return value as PendingTurn[];
}

function writePending(items: PendingTurn[]): void {
  const file = pendingFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items), "utf8");
  fs.renameSync(tmp, file);
}

/** Persist before changing the authoritative chat message. */
export function queueHistoryTurnReconciliation(sessionId: string, turnIds: string[]): void {
  const pending = readPending();
  const keys = new Set(pending.map((item) => `${item.sessionId}\0${item.turnId}`));
  let changed = false;
  for (const turnId of turnIds.filter(Boolean)) {
    const key = `${sessionId}\0${turnId}`;
    if (running) queuedWhileRunning.add(key);
    if (!keys.has(key)) { pending.push({ sessionId, turnId }); keys.add(key); changed = true; }
  }
  if (changed) writePending(pending);
}

function occurrencesForTurn(turnId: string) {
  return getEntriesBySource("chat_history").filter((entry) => {
    const occurrences = entry.metadata?.occurrences;
    return Array.isArray(occurrences)
      ? occurrences.some((item: unknown) => !!item && typeof item === "object"
        && (item as { turnId?: unknown }).turnId === turnId)
      : entry.metadata?.turnId === turnId;
  });
}

function imageKey(filePath: string, index: number): string {
  return createHash("sha256").update(`${index}\0${filePath}`).digest("hex");
}

/** Confirm against the loaded RAG snapshot; pending intent stays until this succeeds. */
export async function retryHistoryTurnReconciliations(): Promise<void> {
  if (running || getStorageStatus().status !== "ready" || !isUserMemoryVectorStoreReady()) return;
  running = true;
  queuedWhileRunning.clear();
  try {
    const pending = readPending();
    if (!pending.length) return;
    const remaining: PendingTurn[] = [];
    for (const item of pending) {
      const message = getSession(item.sessionId)?.messages.find((candidate) => candidate.id === item.turnId);
      const desired = message ? historyIndexText(message) : "";
      const history = occurrencesForTurn(item.turnId);
      const images = getEntriesBySource("chat_image").filter((entry) => entry.metadata?.sessionId === item.sessionId
        && entry.metadata?.turnId === item.turnId);
      const validImageKeys = new Set((message?.attachments ?? []).flatMap((attachment, index) =>
        attachment.kind === "image" ? [imageKey(attachment.filePath, index)] : []));
      const imagesMatch = images.every((entry) => validImageKeys.has(String(entry.metadata?.imageKey ?? "")));
      const occurrence = history[0]?.metadata?.occurrences;
      const position = Array.isArray(occurrence)
        ? occurrence.find((value: unknown) => !!value && typeof value === "object"
          && (value as { turnId?: unknown }).turnId === item.turnId)
        : history[0]?.metadata;
      const historyMatches = history.length === (desired ? 1 : 0) && (!desired || (
        history[0].text === desired
        && position?.ts === message?.at
        && position?.role === (message?.role === "user" ? "user" : "assistant")
      ));
      if (historyMatches && imagesMatch) continue;
      try {
        deleteHistoryEntriesByTurnIds([item.turnId]);
        if (!imagesMatch) deleteChatImagesByTurnIds(item.sessionId, [item.turnId]);
        if (message && desired) {
          await addHistoryMemory(desired, {
            sessionId: item.sessionId,
            role: message.role === "user" ? "user" : "assistant",
            ts: message.at,
            turnId: item.turnId,
          }, { createdAt: message.at });
        }
        if (message?.attachments?.some((attachment) => attachment.kind === "image")) {
          scheduleVisualHistoryIndex(item.sessionId, item.turnId);
        }
        // RAG persistence is debounced; verify from disk on a later startup.
        remaining.push(item);
      } catch (error) {
        remaining.push(item);
        console.warn("[Chats] 历史轮次索引同步失败，下次启动重试:", item.sessionId, item.turnId, error);
      }
    }
    const processed = new Set(pending.map((item) => `${item.sessionId}\0${item.turnId}`));
    const addedMeanwhile = readPending().filter((item) => {
      const key = `${item.sessionId}\0${item.turnId}`;
      return !processed.has(key) || queuedWhileRunning.has(key);
    });
    const retained = new Set(remaining.map((item) => `${item.sessionId}\0${item.turnId}`));
    const uniqueAdded = addedMeanwhile.filter((item) => !retained.has(`${item.sessionId}\0${item.turnId}`));
    if (remaining.length !== pending.length || uniqueAdded.length) writePending([...remaining, ...uniqueAdded]);
  } finally {
    running = false;
    queuedWhileRunning.clear();
  }
}
