// Parsed-lyric disk cache, keyed by encrypted song id. Persists "no lyrics"
// as an empty array too, so quota is never spent twice on the same song.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { LyricLine } from "./lyrics-parser";

const ID_RE = /^[0-9A-Fa-f]{32}$/; // also guards path traversal

export class LyricsCache {
  constructor(private readonly cacheDir: string) {}

  private fileFor(encryptedId: string): string {
    return path.join(this.cacheDir, `${encryptedId.toLowerCase()}.json`);
  }

  /** null = cache miss; [] = cached "no lyrics". */
  async get(encryptedId: string): Promise<LyricLine[] | null> {
    if (!ID_RE.test(encryptedId)) return null;
    try {
      const raw = await fs.readFile(this.fileFor(encryptedId), "utf8");
      const parsed = JSON.parse(raw) as LyricLine[];
      if (!Array.isArray(parsed)) return null;
      return parsed.filter(
        (l) => l && typeof l.timeMs === "number" && typeof l.text === "string",
      );
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null; // corrupt entry = miss; next get() rewrites it
    }
  }

  async set(encryptedId: string, lines: LyricLine[]): Promise<void> {
    if (!ID_RE.test(encryptedId)) return;
    await fs.mkdir(this.cacheDir, { recursive: true });
    const file = this.fileFor(encryptedId);
    const tmp = file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(lines), "utf8");
    await fs.rename(tmp, file);
  }

  async clear(): Promise<void> {
    await fs.rm(this.cacheDir, { recursive: true, force: true });
  }
}
