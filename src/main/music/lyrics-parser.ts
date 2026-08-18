// LRC lyric parser: pure functions, no IO.
// UI contract: `{ timeMs, text }[]` ascending — see refactor plan §10.1 MUSIC_GET_LYRICS.

export interface LyricLine {
  timeMs: number;
  text: string;
}

const TAG_RE = /^\[([^\]]*)\]/;
const TIME_TAG_RE = /^(\d+):(\d{1,2})(?:[.:](\d{1,3}))?$/;
const OFFSET_TAG_RE = /^offset\s*:\s*([+-]?\d+)$/i;

/**
 * Parse an LRC document into a time-sorted timeline.
 *
 * - Supports multiple timestamps per line (`[00:12.00][00:45.10]chorus`).
 * - Supports `mm:ss` / `mm:ss.cs` (2-digit centiseconds) / `mm:ss.mmm`.
 * - Applies the `[offset:±ms]` tag (positive = lyrics appear earlier).
 * - Skips metadata tags (ti/ar/al/by...) and lines with no timestamp.
 * - Returns [] when nothing timestamped is found (caller falls back to txtLyric).
 */
export function parseLrc(lrc: string): LyricLine[] {
  if (!lrc) return [];
  let offsetMs = 0;
  const out: LyricLine[] = [];

  for (const rawLine of lrc.split(/\r?\n/)) {
    let line = rawLine.trim();
    const times: number[] = [];

    // Consume all leading [..] tags.
    for (;;) {
      const m = TAG_RE.exec(line);
      if (!m) break;
      const tag = m[1];
      const timeTag = TIME_TAG_RE.exec(tag);
      if (timeTag) {
        const min = Number(timeTag[1]);
        const sec = Number(timeTag[2]);
        let ms = 0;
        if (timeTag[3]) {
          // ".5"=500ms, ".50"=500ms, ".500"=500ms — pad right to 3 digits.
          ms = Number(timeTag[3].padEnd(3, "0"));
        }
        times.push(min * 60_000 + sec * 1_000 + ms);
      } else {
        const offsetTag = OFFSET_TAG_RE.exec(tag);
        if (offsetTag) offsetMs = Number(offsetTag[1]);
      }
      line = line.slice(m[0].length).trim();
    }

    const text = line;
    if (!text) continue;
    for (const t of times) {
      out.push({ timeMs: Math.max(0, t - offsetMs), text });
    }
  }

  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}
