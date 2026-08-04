import { app } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface WorkMemoryEntry {
  id: string;
  content: string;
  sourceSessionId: string;
  createdAt: number;
  updatedAt: number;
}
const MAX_ENTRIES = 500;

function memoryPath(): string {
  return path.join(app.getPath("userData"), "cyrene-work", "memory", "entries.json");
}

function readEntries(): WorkMemoryEntry[] {
  const filePath = memoryPath();
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is WorkMemoryEntry => Boolean(
          entry && typeof entry === "object" && typeof (entry as WorkMemoryEntry).content === "string",
        ))
      : [];
  } catch {
    return [];
  }
}

function writeEntries(entries: WorkMemoryEntry[]): void {
  const filePath = memoryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function tokens(text: string): Set<string> {
  const normalized = text.toLowerCase();
  const words = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const grams: string[] = [];
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const gram = normalized.slice(i, i + 2);
    if (!/\s/.test(gram)) grams.push(gram);
  }
  return new Set([...words, ...grams]);
}

export function saveWorkMemory(content: string, sourceSessionId: string): WorkMemoryEntry {
  const clean = content.trim().slice(0, 4_000);
  if (!clean) throw new Error("Work memory cannot be empty");
  const entries = readEntries();
  const existing = entries.find((entry) => entry.content === clean);
  if (existing) {
    existing.updatedAt = Date.now();
    existing.sourceSessionId = sourceSessionId;
    writeEntries(entries);
    return existing;
  }
  const now = Date.now();
  const entry: WorkMemoryEntry = {
    id: randomUUID(),
    content: clean,
    sourceSessionId,
    createdAt: now,
    updatedAt: now,
  };
  entries.push(entry);
  writeEntries(entries);
  return entry;
}

export function searchWorkMemory(query: string, limit = 6): WorkMemoryEntry[] {
  const queryTokens = tokens(query);
  if (queryTokens.size === 0) return [];
  return readEntries()
    .map((entry) => {
      const entryTokens = tokens(entry.content);
      let score = 0;
      for (const token of queryTokens) if (entryTokens.has(token)) score += token.length;
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)
    .slice(0, Math.max(1, Math.min(limit, 20)))
    .map((item) => ({ ...item.entry }));
}

export function listWorkMemory(): WorkMemoryEntry[] {
  return readEntries().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteWorkMemory(id: string): boolean {
  const entries = readEntries();
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) return false;
  writeEntries(next);
  return true;
}
