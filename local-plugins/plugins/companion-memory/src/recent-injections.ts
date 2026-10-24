import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

const TTL_MS = 10 * 60 * 1000;
const MAX = 20;
const KEY = "isolated-recent-injections";
interface Persistence { storage: PluginStorage; assertHealthy(): void }
export function createRecentInjections(now: () => number = Date.now, persistence?: Persistence) {
  let records = new Map<string, number>();
  const prune = (target = records) => {
    const minimum = now() - TTL_MS;
    for (const [id, at] of target) if (at < minimum) target.delete(id);
    const ordered = [...target.entries()].sort((a, b) => b[1] - a[1]);
    for (const [id] of ordered.slice(MAX)) target.delete(id);
  };
  if (persistence) {
    persistence.assertHealthy();
    const value = persistence.storage.get<{ version: 1; records: Array<[string, number]> }>(KEY);
    if (value !== undefined) {
      if (!value || value.version !== 1 || !Array.isArray(value.records) || value.records.length > MAX
        || value.records.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || !row[0] || !Number.isFinite(row[1]))
        || new Set(value.records.map(row => row[0])).size !== value.records.length) throw new Error("SQLITE_RECENT_INJECTIONS_CORRUPT");
      records = new Map(value.records);
      prune();
    }
  }
  return {
    record(ids: string[], at = now()) {
      persistence?.assertHealthy();
      const next = new Map(records);
      for (const id of new Set(ids)) if (id) next.set(id, persistence ? Math.max(next.get(id) ?? -Infinity, at) : at);
      prune(next);
      persistence?.storage.set(KEY, { version: 1, records: [...next.entries()] });
      records = next;
    },
    has(id: string) { persistence?.assertHealthy(); prune(); return records.has(id); },
    // Stop only releases this instance. Successful prompt timestamps must survive process replacement.
    clear() { records.clear(); },
  };
}
