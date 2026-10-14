import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

/** Local bounded diagnostics, separate from memory/vector/recall state. */
export function createMemoryAudit(storage: PluginStorage) {
  let pending = 0;
  return (event: Record<string, unknown>) => {
    if (pending >= 16) return;
    pending++;
    setImmediate(() => {
      try {
        const row = { at: Date.now(), ...event };
        const size = JSON.stringify(row).length;
        if (size > 64_000) return;
        const previous = storage.get<unknown>("retrieval-shadow-audit");
        const rows: unknown[] = Array.isArray(previous) ? [...previous.slice(-99), row] : [row];
        while (rows.length > 1 && JSON.stringify(rows).length > 512_000) rows.shift();
        storage.set("retrieval-shadow-audit", rows);
      } catch { /* Observations cannot fail a chat turn. */ }
      finally { pending--; }
    });
  };
}
