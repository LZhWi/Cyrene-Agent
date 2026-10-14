import { createHash } from "node:crypto";
import type { Entry } from "./entries";
import { isRecallable } from "./entries";
import type { InboxState } from "./maintenance-inbox";

export interface LegacyCompatibility {
  maintenanceInbox: InboxState;
  dream: { version: 1; revision: 0; narratives: Array<{ id: string; text: string; createdAt: number; origin: "legacy" }>; reviews: [] };
  summary: { conflictPairs: number; openConflicts: number; quarantinedConflicts: number; dreamNarratives: number; quarantinedDreams: number; pendingTurns: number };
}

/** Keep the full source separately. Only validated, representable state becomes executable. */
export function createLegacyCompatibility(raw: any, entries: Entry[], now = Date.now()): LegacyCompatibility {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const latest = new Map<string, any>();
  let quarantinedConflicts = 0;
  for (const log of raw.conflictLogs ?? []) {
    if (!log || typeof log.id !== "string" || !log.id || !Number.isFinite(log.createdAt)
      || log.sourceL2Id === log.targetL2Id || !byId.has(log.sourceL2Id) || !byId.has(log.targetL2Id)
      || !["candidate", "pending", "confirmed", "dismissed", "resolved", "clarification_needed"].includes(log.status)
      || typeof log.reason !== "string" || !log.reason || log.reason.length > 1500) {
      quarantinedConflicts++;
      continue;
    }
    const key = [log.sourceL2Id, log.targetL2Id].sort().join("\u0000");
    if (!latest.has(key) || log.createdAt >= latest.get(key).createdAt) latest.set(key, log);
  }
  const items: InboxState["items"] = [];
  for (const [key, log] of latest) {
    const [leftId, rightId] = key.split("\u0000");
    const left = byId.get(leftId)!, right = byId.get(rightId)!;
    const terminal = log.status === "dismissed" || log.status === "resolved";
    // Obsolete candidates must not be resurrected as new resolver work.
    if (!terminal && (!isRecallable(left, now) || !isRecallable(right, now))) { quarantinedConflicts++; continue; }
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    items.push({ id: `legacy:${log.id}`, key, leftId, rightId, kind: "conflict", leftHash: hash(left.content),
      rightHash: hash(right.content), createdAt: log.createdAt, status: terminal ? "dismissed" : "open",
      reason: log.reason, resolverPriority: terminal ? "none" : ["none", "idle", "normal", "high"].includes(log.resolverPriority) ? log.resolverPriority : "normal",
      ...(Number.isFinite(log.conflictScore) && log.conflictScore >= 0 && log.conflictScore <= 100 ? { conflictScore: log.conflictScore } : {}) });
  }
  if (items.length > 500) throw new Error("旧冲突候选超过插件收件箱容量，拒绝静默截断");
  const narratives: LegacyCompatibility["dream"]["narratives"] = [];
  const seen = new Set<string>();
  let quarantinedDreams = 0;
  for (const narrative of raw.dreamNarratives ?? []) {
    if (!narrative || typeof narrative.id !== "string" || !narrative.id || seen.has(narrative.id)
      || typeof narrative.text !== "string" || narrative.text.length < 20 || narrative.text.length > 600
      || !Number.isFinite(narrative.createdAt)) { quarantinedDreams++; continue; }
    seen.add(narrative.id);
    narratives.push({ id: narrative.id, text: narrative.text, createdAt: narrative.createdAt, origin: "legacy" });
  }
  if (narratives.length > 8) throw new Error("旧 Dream 超过插件容量，拒绝静默截断");
  return {
    maintenanceInbox: { version: 1, revision: 0, items },
    dream: { version: 1, revision: 0, narratives, reviews: [] },
    summary: { conflictPairs: items.length, openConflicts: items.filter((item) => item.status === "open").length,
      quarantinedConflicts, dreamNarratives: narratives.length, quarantinedDreams, pendingTurns: raw.pendingTurns?.length ?? 0 },
  };
}
