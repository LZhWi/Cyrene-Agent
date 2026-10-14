import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { LegacyRuntimePlan } from "./legacy-runtime";
import type { InboxState } from "./maintenance-inbox";

export interface RuntimeSnapshot {
  dmae: LegacyRuntimePlan["dmae"];
  lifecycle: Omit<LegacyRuntimePlan["lifecycle"], "revision"> & { revision: number };
  inbox: InboxState;
}
const equal = (a: unknown, b: unknown) => isDeepStrictEqual(structuredClone(a), structuredClone(b));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Pure offline plan. The caller must validate and commit the whole candidate while writers are stopped. */
export function planLegacyRuntimeIncremental(
  baseline: RuntimeSnapshot,
  current: RuntimeSnapshot,
  incoming: RuntimeSnapshot,
  entries: Array<{ id: string; content: string }>,
  options: { replaceTestDmae?: boolean } = {},
) {
  const next = structuredClone(current);
  const nextBaseline = structuredClone(incoming);
  const changes: string[] = [], conflicts: string[] = [];
  const known = new Map(entries.map(entry => [entry.id, entry]));
  if (known.size !== entries.length) throw new Error("记忆 ID 重复");
  // DMAE rounds are one clock domain: never combine activations from independent timelines.
  if (!equal(current.dmae, incoming.dmae) && (options.replaceTestDmae || !equal(baseline.dmae, incoming.dmae))) {
    if ((options.replaceTestDmae || equal(current.dmae, baseline.dmae))
      && Object.keys(incoming.dmae.states).every(id => known.has(id))) {
      next.dmae = structuredClone(incoming.dmae); changes.push("dmae");
    } else { conflicts.push("dmae:diverged-or-unmapped"); nextBaseline.dmae = structuredClone(baseline.dmae); }
  }
  for (const [id, value] of Object.entries(incoming.lifecycle.recalls)) {
    const old = baseline.lifecycle.recalls[id], local = current.lifecycle.recalls[id];
    const preserveBaseline = () => {
      if (old === undefined) delete nextBaseline.lifecycle.recalls[id];
      else nextBaseline.lifecycle.recalls[id] = structuredClone(old);
    };
    if (!known.has(id)) { conflicts.push(`lifecycle:${id}:unmapped`); preserveBaseline(); continue; }
    if (equal(local, value) || equal(old, value)) continue;
    // A missing local row with an old baseline row is a deletion, not an insertion opportunity.
    if (equal(local, old)) { next.lifecycle.recalls[id] = structuredClone(value); changes.push(`lifecycle:${id}`); }
    else { conflicts.push(`lifecycle:${id}:local-change`); preserveBaseline(); }
  }
  if (!equal(current.lifecycle.lastDecayAt, incoming.lifecycle.lastDecayAt)
    && !equal(baseline.lifecycle.lastDecayAt, incoming.lifecycle.lastDecayAt)) {
    if (equal(current.lifecycle.lastDecayAt, baseline.lifecycle.lastDecayAt)
      && !conflicts.some(key => key.startsWith("lifecycle:"))) {
      if (incoming.lifecycle.lastDecayAt === undefined) delete next.lifecycle.lastDecayAt;
      else next.lifecycle.lastDecayAt = incoming.lifecycle.lastDecayAt;
      changes.push("lifecycle:lastDecayAt");
    } else {
      conflicts.push("lifecycle:lastDecayAt:local-change");
      if (baseline.lifecycle.lastDecayAt === undefined) delete nextBaseline.lifecycle.lastDecayAt;
      else nextBaseline.lifecycle.lastDecayAt = baseline.lifecycle.lastDecayAt;
    }
  }
  if (changes.some(key => key.startsWith("lifecycle:"))) next.lifecycle.revision++;

  const keyed = (items: InboxState["items"]) => {
    const map = new Map(items.map(item => [item.key, item]));
    if (map.size !== items.length) throw new Error("冲突候选键重复");
    return map;
  };
  const oldItems = keyed(baseline.inbox.items), currentItems = keyed(current.inbox.items);
  keyed(incoming.inbox.items);
  for (const item of incoming.inbox.items) {
    const local = currentItems.get(item.key), old = oldItems.get(item.key);
    const preserveBaseline = () => {
      nextBaseline.inbox.items = nextBaseline.inbox.items.filter(row => row.key !== item.key);
      if (old) nextBaseline.inbox.items.push(structuredClone(old));
    };
    if (equal(local, item) || equal(old, item)) continue;
    if (!equal(local, old)) { conflicts.push(`inbox:${item.id}:local-change`); preserveBaseline(); continue; }
    const left = known.get(item.leftId), right = known.get(item.rightId);
    if (!left || !right || hash(left.content) !== item.leftHash || hash(right.content) !== item.rightHash) {
      conflicts.push(`inbox:${item.id}:stale-evidence`); preserveBaseline(); continue;
    }
    const index = next.inbox.items.findIndex(row => row.key === item.key);
    if (index >= 0) next.inbox.items[index] = structuredClone(item);
    else next.inbox.items.push(structuredClone(item));
    changes.push(`inbox:${item.id}`);
  }
  if (next.inbox.items.length > 500) throw new Error("冲突收件箱超过容量，拒绝截断");
  if (new Set(next.inbox.items.map(item => item.id)).size !== next.inbox.items.length) throw new Error("冲突候选 ID 重复");
  if (changes.some(key => key.startsWith("inbox:"))) next.inbox.revision++;
  return { next, baseline: nextBaseline, changes, conflicts };
}
