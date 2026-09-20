import { createHash, randomUUID } from "node:crypto";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import type { Entry } from "./entries";
import { isRecallable } from "./entries";

const STATE_KEY = "maintenance-inbox";
interface Candidate { key: string; leftId: string; rightId: string; kind: "normalized-duplicate" | "vector-similar"; score?: number; leftHash: string; rightHash: string }
interface Item extends Candidate { id: string; createdAt: number; status: "open" | "dismissed" }
interface InboxState { version: 1; revision: number; items: Item[] }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]/gu, "");
const pairKey = (left: string, right: string) => [left, right].sort().join("\u0000");

function load(storage: PluginStorage): InboxState {
  const raw = storage.get<unknown>(STATE_KEY);
  if (raw === undefined) return { version: 1, revision: 0, items: [] };
  if (!raw || typeof raw !== "object") throw new Error("维护候选收件箱损坏");
  const state = raw as Partial<InboxState>;
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision! < 0 || !Array.isArray(state.items) || state.items.length > 500 || state.items.some((item) => !item || typeof item.id !== "string" || !item.id || typeof item.key !== "string" || !item.key || typeof item.leftId !== "string" || typeof item.rightId !== "string" || item.leftId === item.rightId || !["normalized-duplicate", "vector-similar"].includes(item.kind) || !/^[a-f0-9]{64}$/.test(item.leftHash) || !/^[a-f0-9]{64}$/.test(item.rightHash) || !Number.isFinite(item.createdAt) || !["open", "dismissed"].includes(item.status) || (item.score !== undefined && (!Number.isFinite(item.score) || item.score < -1 || item.score > 1)))) throw new Error("维护候选收件箱损坏");
  const ids = new Set<string>(), keys = new Set<string>();
  for (const item of state.items) {
    if (ids.has(item.id) || keys.has(item.key) || item.key !== pairKey(item.leftId, item.rightId)) throw new Error("维护候选收件箱损坏");
    ids.add(item.id); keys.add(item.key);
  }
  return structuredClone(state as InboxState);
}

export function createMaintenanceInbox(storage: PluginStorage) {
  let state = load(storage);
  const collect = (entries: Entry[], vectorPairs: Array<{ leftId: string; rightId: string; score: number }>): Candidate[] => {
    const active = entries.filter((entry) => isRecallable(entry, Date.now())), byId = new Map(active.map((entry) => [entry.id, entry])), pairs = new Map<string, Candidate>();
    const groups = new Map<string, Entry[]>();
    for (const entry of active.slice(0, 300)) { const key = normalized(entry.content); if (key) groups.set(key, [...(groups.get(key) ?? []), entry]); }
    for (const group of groups.values()) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      const [left, right] = [group[i], group[j]].sort((a, b) => a.id.localeCompare(b.id)), key = pairKey(left.id, right.id);
      pairs.set(key, { key, leftId: left.id, rightId: right.id, kind: "normalized-duplicate", leftHash: hash(left.content), rightHash: hash(right.content) });
    }
    for (const pair of vectorPairs) {
      const left = byId.get(pair.leftId), right = byId.get(pair.rightId); if (!left || !right || left.id === right.id) continue;
      const [a, b] = [left, right].sort((x, y) => x.id.localeCompare(y.id)), key = pairKey(a.id, b.id);
      if (!pairs.has(key)) pairs.set(key, { key, leftId: a.id, rightId: b.id, kind: "vector-similar", score: pair.score, leftHash: hash(a.content), rightHash: hash(b.content) });
    }
    return [...pairs.values()];
  };
  const available = (entries: Entry[], vectorPairs: Array<{ leftId: string; rightId: string; score: number }>) => {
    const existing = new Set(state.items.map((item) => item.key));
    return collect(entries, vectorPairs).filter((candidate) => !existing.has(candidate.key)).slice(0, 100);
  };
  return {
    view(entries: Entry[]) {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      return { revision: state.revision, items: structuredClone(state.items.map((item) => ({ ...item, stale: hash(byId.get(item.leftId)?.content ?? "") !== item.leftHash || hash(byId.get(item.rightId)?.content ?? "") !== item.rightHash }))) };
    },
    preview(entries: Entry[], vectorPairs: Array<{ leftId: string; rightId: string; score: number }>) {
      const candidates = available(entries, vectorPairs), previewToken = hash(JSON.stringify(candidates));
      return { inboxRevision: state.revision, candidates, previewToken };
    },
    add(raw: any, entries: Entry[], vectorPairs: Array<{ leftId: string; rightId: string; score: number }>) {
      if (!raw || raw.inboxRevision !== state.revision || typeof raw.previewToken !== "string" || !Array.isArray(raw.keys) || raw.keys.length < 1 || raw.keys.length > 50 || raw.keys.some((key: unknown) => typeof key !== "string") || new Set(raw.keys).size !== raw.keys.length) throw new Error("维护候选提交参数无效或预检已过期");
      const candidates = available(entries, vectorPairs);
      if (hash(JSON.stringify(candidates)) !== raw.previewToken) throw new Error("维护候选预检已过期，请重新扫描");
      const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
      if (raw.keys.some((key: string) => !byKey.has(key))) throw new Error("所选维护候选已失效");
      const additions = raw.keys.map((key: string) => ({ ...byKey.get(key)!, id: randomUUID(), createdAt: Date.now(), status: "open" as const }));
      state = { version: 1, revision: state.revision + 1, items: [...state.items, ...additions].slice(-500) }; storage.set(STATE_KEY, state);
      return this.view(entries);
    },
    addAutomatically(entries: Entry[], vectorPairs: Array<{ leftId: string; rightId: string; score: number }>) {
      const candidates = available(entries, vectorPairs);
      if (!candidates.length) return 0;
      const additions = candidates.map((candidate) => ({ ...candidate, id: randomUUID(), createdAt: Date.now(), status: "open" as const }));
      state = { version: 1, revision: state.revision + 1, items: [...state.items, ...additions].slice(-500) }; storage.set(STATE_KEY, state);
      return additions.length;
    },
    dismiss(raw: any, entries: Entry[]) {
      if (!raw || typeof raw.id !== "string") throw new Error("维护候选操作无效");
      const item = state.items.find((entry) => entry.id === raw.id); if (!item || item.status !== "open") throw new Error("维护候选操作无效");
      state = { ...state, revision: state.revision + 1, items: state.items.map((entry) => entry.id === item.id ? { ...entry, status: "dismissed" as const } : entry) }; storage.set(STATE_KEY, state);
      return this.view(entries);
    },
  };
}
