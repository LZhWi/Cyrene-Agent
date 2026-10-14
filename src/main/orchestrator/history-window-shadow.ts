import { createHash, randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { getUserDataDir } from "../runtime/runtime-paths";
import type { HistoryRetrievalHit } from "./history-retrieval-diagnostics";

export interface WindowShadowEvidence {
  candidates?: HistoryRetrievalHit[];
  ranked?: Array<{ text: string; score: number; relevanceScore: number }>;
}

/** v62 guarded presentation: reuse existing scores; never retrieve or update memory. */
export function presentHistoryWindow(hit: HistoryRetrievalHit, evidence: WindowShadowEvidence) {
  const prefix = { start: 0, end: Math.min(300, hit.text.length), text: hit.text.slice(0, 300) };
  if (hit.text.length <= 300) return { ...prefix, reason: "short_unchanged" };
  const options = (evidence.candidates ?? []).filter(c =>
    c.metadata?.retrievalExpansion === "sentence_window"
    && c.metadata?.retrievalParentText === hit.text
    && c.metadata?.turnId === hit.metadata?.turnId
    && c.metadata?.sessionId === hit.metadata?.sessionId,
  ).map(c => ({ c, r: evidence.ranked?.find(r => r.text === c.text) }))
    .filter(x => x.r && x.r.relevanceScore >= -6)
    .sort((a, b) => b.r!.score - a.r!.score);
  const normalize = (text: string) => {
    const offsets: number[] = [];
    let value = "";
    for (let i = 0; i < text.length; i++) if (!/\s/u.test(text[i])) {
      value += text[i]; offsets.push(i);
    }
    return { value, offsets };
  };
  const parent = normalize(hit.text);
  for (const { c, r } of options) {
    const window = normalize(c.text).value;
    const at = parent.value.indexOf(window);
    if (!window || at < 0 || parent.value.indexOf(window, at + 1) >= 0) continue;
    let start = parent.offsets[at], end = parent.offsets[at + window.length - 1] + 1;
    if (end - start > 300) continue;
    const anchor = { start, end };
    const spans = [...new Intl.Segmenter("zh", { granularity: "sentence" }).segment(hit.text)]
      .map(s => ({ start: s.index, end: s.index + s.segment.length }));
    let changed = true;
    while (changed) {
      changed = false;
      const prev = [...spans].reverse().find(s => s.end <= start);
      if (prev && end - prev.start <= 300) { start = prev.start; changed = true; }
      const next = spans.find(s => s.start >= end);
      if (next && next.end - start <= 300) { end = next.end; changed = true; }
    }
    if (start === 0 && end < prefix.end) return { ...prefix, reason: "prefix_subset_guard" };
    return { start, end, text: hit.text.slice(start, end), reason: "existing_window", anchor, windowScore: r!.score };
  }
  return { ...prefix, reason: "prefix_fallback" };
}

let pending = 0;
let writes = Promise.resolve();
const MAX_BYTES = 10 * 1024 * 1024;

/** Best-effort bounded local observer; callers never await this side effect. */
export function recordHistoryWindowShadow(input: {
  userQuery: string; toolQuery: string; source: "tool" | "auto_injection";
  finalK: number; days: number; selected: HistoryRetrievalHit[]; evidence: WindowShadowEvidence;
}): void {
  if (process.env.CYRENE_HISTORY_WINDOW_SHADOW === "0" || pending >= 32) return;
  try {
    const rows = input.selected.map(hit => ({
      sessionId: hit.metadata?.sessionId, turnId: hit.metadata?.turnId,
      role: hit.metadata?.role, createdAt: hit.createdAt, score: hit.score,
      originalLength: hit.text.length,
      originalHash: createHash("sha256").update(hit.text).digest("hex"),
      official: { start: 0, end: Math.min(300, hit.text.length),
        text: hit.text.length > 300 ? hit.text.slice(0, 300) + "..." : hit.text },
      shadow: presentHistoryWindow(hit, input.evidence),
    }));
    const line = JSON.stringify({ version: "sentence-window-v62-shadow-1", id: randomUUID(),
      at: new Date().toISOString(), source: input.source, userQuery: input.userQuery,
      toolQuery: input.toolQuery, days: input.days, finalK: input.finalK,
      selectedCount: rows.length, actualResultUnchanged: true, rows }) + "\n";
    if (Buffer.byteLength(line) > MAX_BYTES) return;
    const file = path.join(getUserDataDir(), "logs", "history-window-shadow.jsonl");
    pending++;
    writes = writes.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const size = await fs.stat(file).then(s => s.size, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return 0;
        throw error;
      });
      if (size + Buffer.byteLength(line) > MAX_BYTES) {
        await fs.rm(file + ".1", { force: true });
        await fs.rename(file, file + ".1");
      }
      await fs.appendFile(file, line, "utf8");
    }).catch(error => { console.warn("[History/WindowShadow] log skipped:", error); })
      .finally(() => { pending--; });
  } catch (error) {
    console.warn("[History/WindowShadow] observation skipped:", error);
  }
}

export async function flushHistoryWindowShadow(): Promise<void> { await writes; }
