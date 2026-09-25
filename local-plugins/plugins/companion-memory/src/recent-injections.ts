const TTL_MS = 10 * 60 * 1000;
const MAX = 20;

export function createRecentInjections(now: () => number = Date.now) {
  const records = new Map<string, number>();
  const prune = () => {
    const minimum = now() - TTL_MS;
    for (const [id, at] of records) if (at < minimum) records.delete(id);
    const ordered = [...records.entries()].sort((a, b) => b[1] - a[1]);
    for (const [id] of ordered.slice(MAX)) records.delete(id);
  };
  return {
    record(ids: string[]) { const at = now(); for (const id of new Set(ids)) if (id) records.set(id, at); prune(); },
    has(id: string) { prune(); return records.has(id); },
    clear() { records.clear(); },
  };
}
