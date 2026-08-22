import * as fs from "fs";
import * as path from "path";

export interface CachePruneResult {
  beforeBytes: number;
  afterBytes: number;
  removed: number;
}

export function pruneDirectoryByMtimeSync(
  directory: string,
  maxBytes: number,
  targetBytes: number,
): CachePruneResult {
  if (!fs.existsSync(directory)) return { beforeBytes: 0, afterBytes: 0, removed: 0 };
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = fs.statSync(filePath);
      return { filePath, size: stat.size, age: Math.max(stat.atimeMs, stat.mtimeMs) };
    });
  const beforeBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (beforeBytes <= maxBytes) return { beforeBytes, afterBytes: beforeBytes, removed: 0 };

  let afterBytes = beforeBytes;
  let removed = 0;
  for (const file of files.sort((a, b) => a.age - b.age)) {
    if (afterBytes <= targetBytes) break;
    try {
      fs.unlinkSync(file.filePath);
      afterBytes -= file.size;
      removed++;
    } catch {
      // A locked cache entry is skipped; later entries can still be reclaimed.
    }
  }
  return { beforeBytes, afterBytes, removed };
}
