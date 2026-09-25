import { createHash } from "node:crypto";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import type { Entry } from "./entries";

const SETTINGS_KEY = "lifecycle-tracking-enabled";
const STATE_KEY = "lifecycle-state";
const DAY_MS = 24 * 60 * 60 * 1000;
interface RecallStat { lastHitAt: number; hitCount: number; weight: number }
interface LifecycleState { version: 1; revision: number; recalls: Record<string, RecallStat>; lastDecayAt?: number }

function load(storage: PluginStorage): LifecycleState {
  const saved = storage.get<unknown>(STATE_KEY);
  const value = saved === undefined ? (storage.get<any>("memory-state")?.legacyRuntime?.lifecycle) : saved;
  if (value === undefined) return { version: 1, revision: 0, recalls: {} };
  if (!value || typeof value !== "object") throw new Error("生命周期状态损坏");
  const state = value as Partial<LifecycleState>;
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision! < 0 || !state.recalls || typeof state.recalls !== "object" || Array.isArray(state.recalls) || Object.keys(state.recalls).length > 20_000 || Object.entries(state.recalls).some(([id, item]) => {
    const stat = item as Partial<RecallStat> | undefined;
    return !id || !stat || !Number.isFinite(stat.lastHitAt) || stat.lastHitAt! < 0 || !Number.isSafeInteger(stat.hitCount) || stat.hitCount! < 0 || (stat.weight !== undefined && (!Number.isSafeInteger(stat.weight) || stat.weight < 0 || stat.weight > 100));
  }) || (state.lastDecayAt !== undefined && (!Number.isFinite(state.lastDecayAt) || state.lastDecayAt < 0))) throw new Error("生命周期状态损坏");
  const normalized = structuredClone(state as LifecycleState);
  for (const stat of Object.values(normalized.recalls)) stat.weight ??= 0;
  return normalized;
}

type LifecycleTarget = "aging" | "archived";
function token(revision: number, days: number, target: LifecycleTarget, candidates: Array<{ id: string; referenceAt: number }>) {
  return createHash("sha256").update(JSON.stringify({ revision, days, target, candidates })).digest("hex");
}

export function createLifecycle(storage: PluginStorage, now: () => number = Date.now) {
  let enabled = storage.get<boolean>(SETTINGS_KEY) ?? false;
  if (typeof enabled !== "boolean") throw new Error("生命周期跟踪设置损坏");
  let state = load(storage);
  const candidates = (entries: Entry[], days: number, target: LifecycleTarget) => {
    const cutoff = now() - days * DAY_MS;
    const currentStatus = target === "aging" ? "active" : "aging";
    return entries.filter((entry) => entry.status === currentStatus && !entry.pinned && !entry.supersededBy && !entry.mergedInto).map((entry) => {
      const recall = state.recalls[entry.id];
      return { id: entry.id, content: entry.content, referenceAt: recall?.lastHitAt ?? entry.sourceEndAt ?? entry.sourceAt, basis: recall ? "last-injected" as const : "source-time" as const, hitCount: recall?.hitCount ?? 0 };
    }).filter((entry) => entry.referenceAt <= cutoff).sort((a, b) => a.referenceAt - b.referenceAt || a.id.localeCompare(b.id)).slice(0, 200);
  };
  const capacityPreview = (entries: Entry[]) => {
    const activeCap = 300, totalCap = 800, halfLifeMs = 30 * DAY_MS, at = now();
    const row = (entry: Entry) => {
      const recall = state.recalls[entry.id], referenceAt = recall?.lastHitAt ?? entry.sourceEndAt ?? entry.sourceAt;
      const weight = recall?.weight ?? 0, age = Math.max(0, at - referenceAt);
      return { id: entry.id, content: entry.content, status: entry.status, weight, referenceAt, score: weight * Math.pow(0.5, age / halfLifeMs) };
    };
    const active = entries.filter((entry) => entry.status === "active" && !entry.pinned && !entry.supersededBy && !entry.mergedInto).map(row);
    const toAging = active.sort((left, right) => left.score - right.score || left.referenceAt - right.referenceAt || left.id.localeCompare(right.id)).slice(0, Math.max(0, entries.filter((entry) => entry.status === "active").length - activeCap));
    const demoted = new Set(toAging.map((entry) => entry.id));
    const workingSetCount = entries.filter((entry) => entry.status === "active" || entry.status === "aging").length;
    const toArchive = entries.filter((entry) => (entry.status === "aging" || demoted.has(entry.id)) && !entry.pinned && !entry.supersededBy && !entry.mergedInto).map(row)
      .sort((left, right) => left.score - right.score || left.referenceAt - right.referenceAt || left.id.localeCompare(right.id)).slice(0, Math.max(0, workingSetCount - totalCap));
    const signature = { lifecycleRevision: state.revision, activeCap, totalCap, toAging: toAging.map(({ id, status, weight, referenceAt }) => ({ id, status, weight, referenceAt })), toArchive: toArchive.map(({ id, status, weight, referenceAt }) => ({ id, status, weight, referenceAt })) };
    return { lifecycleRevision: state.revision, activeCap, totalCap, halfLifeMs, activeCount: entries.filter((entry) => entry.status === "active").length, workingSetCount, toAging, toArchive, token: createHash("sha256").update(JSON.stringify(signature)).digest("hex") };
  };
  return {
    view() { return { enabled, revision: state.revision, tracked: Object.keys(state.recalls).length }; },
    reload() { state = load(storage); return this.view(); },
    remove(id: string) {
      if (!state.recalls[id]) return false;
      const recalls = { ...state.recalls };
      delete recalls[id];
      state = { ...state, revision: state.revision + 1, recalls };
      storage.set(STATE_KEY, state);
      return true;
    },
    reconcile(knownIds: string[]) {
      const known = new Set(knownIds), recalls = Object.fromEntries(Object.entries(state.recalls).filter(([id]) => known.has(id)));
      const removed = Object.keys(state.recalls).length - Object.keys(recalls).length;
      if (removed) { state = { ...state, revision: state.revision + 1, recalls }; storage.set(STATE_KEY, state); }
      return { removed, ...this.view() };
    },
    set(value: unknown) {
      if (typeof value !== "boolean") throw new Error("生命周期跟踪设置无效");
      storage.set(SETTINGS_KEY, value); enabled = value;
      return this.view();
    },
    record(ids: string[], entries: Entry[], force = false) {
      if (!enabled && !force) return { recordedIds: [] as string[], reactivateIds: [] as string[] };
      const known = new Set(entries.map((entry) => entry.id)), unique = [...new Set(ids)].filter((id) => known.has(id));
      if (!unique.length) return { recordedIds: [] as string[], reactivateIds: [] as string[] };
      const at = now(), recalls = { ...state.recalls };
      for (const id of unique) recalls[id] = { lastHitAt: at, hitCount: (recalls[id]?.hitCount ?? 0) + 1, weight: Math.min(100, (recalls[id]?.weight ?? 0) + 1) };
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const reactivateIds = unique.filter((id) => byId.get(id)?.status === "aging" && recalls[id].weight >= 30);
      state = { ...state, version: 1, revision: state.revision + 1, recalls };
      storage.set(STATE_KEY, state);
      return { recordedIds: unique, reactivateIds };
    },
    decayWeights(entries: Entry[]) {
      if (!enabled) return { changed: 0, lastDecayAt: state.lastDecayAt };
      const at = now();
      if (state.lastDecayAt !== undefined && at - state.lastDecayAt < DAY_MS) return { changed: 0, lastDecayAt: state.lastDecayAt };
      const eligible = new Set(entries.filter((entry) => !entry.pinned && (entry.status === "active" || entry.status === "aging") && !entry.supersededBy && !entry.mergedInto).map((entry) => entry.id));
      let changed = 0;
      const recalls = Object.fromEntries(Object.entries(state.recalls).map(([id, stat]) => {
        const weight = eligible.has(id) ? Math.max(0, stat.weight - 1) : stat.weight;
        if (weight !== stat.weight) changed += 1;
        return [id, { ...stat, weight }];
      }));
      state = { version: 1, revision: state.revision + 1, recalls, lastDecayAt: at };
      storage.set(STATE_KEY, state);
      return { changed, lastDecayAt: at };
    },
    previewCapacity(entries: Entry[]) {
      return capacityPreview(entries);
    },
    validateCapacity(entries: Entry[], raw: any) {
      if (!raw || !Number.isSafeInteger(raw.lifecycleRevision) || typeof raw.token !== "string") throw new Error("容量计划参数无效");
      const current = capacityPreview(entries);
      if (raw.lifecycleRevision !== current.lifecycleRevision || raw.token !== current.token) throw new Error("容量预检已过期，请重新预检");
      const agingEntryIds = current.toAging.slice(0, 100).map((entry) => entry.id);
      const aging = new Set(agingEntryIds);
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const archivedEntryIds = current.toArchive.filter((entry) => byId.get(entry.id)?.status === "aging" || aging.has(entry.id)).slice(0, 100).map((entry) => entry.id);
      return { agingEntryIds, archivedEntryIds };
    },
    preview(entries: Entry[], raw?: unknown) {
      const days = typeof raw === "object" && raw && Number.isSafeInteger((raw as any).days) ? (raw as any).days : 30;
      const target = typeof raw === "object" && raw && (raw as any).target === "archived" ? "archived" : "aging";
      const minimum = target === "archived" ? 90 : 30;
      if (days < minimum || days > 3650) throw new Error(`闲置天数必须在 ${minimum} 至 3650 天之间`);
      const rows = candidates(entries, days, target);
      return { lifecycleRevision: state.revision, days, target, candidates: rows, truncated: rows.length === 200, token: token(state.revision, days, target, rows.map(({ id, referenceAt }) => ({ id, referenceAt }))) };
    },
    validateApply(entries: Entry[], raw: any) {
      if (!raw || !Number.isSafeInteger(raw.days) || !["aging", "archived"].includes(raw.target) || !Number.isSafeInteger(raw.lifecycleRevision) || typeof raw.token !== "string" || !Array.isArray(raw.entryIds) || raw.entryIds.length < 1 || raw.entryIds.length > 100 || raw.entryIds.some((id: unknown) => typeof id !== "string") || new Set(raw.entryIds).size !== raw.entryIds.length) throw new Error("生命周期应用参数无效");
      const target = raw.target as LifecycleTarget, minimum = target === "archived" ? 90 : 30;
      if (raw.days < minimum || raw.days > 3650) throw new Error("生命周期应用参数无效");
      const rows = candidates(entries, raw.days, target), expected = token(state.revision, raw.days, target, rows.map(({ id, referenceAt }) => ({ id, referenceAt })));
      if (raw.lifecycleRevision !== state.revision || raw.token !== expected) throw new Error("生命周期预检已过期，请重新预检");
      const allowed = new Set(rows.map((row) => row.id));
      if (raw.entryIds.some((id: string) => !allowed.has(id))) throw new Error("所选记忆已不满足老化条件，请重新预检");
      return { entryIds: raw.entryIds as string[], target };
    },
  };
}
