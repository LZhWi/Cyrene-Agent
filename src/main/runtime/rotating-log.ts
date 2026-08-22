import * as fs from "fs";
import * as path from "path";

export const DEFAULT_LOG_MAX_BYTES = 8 * 1024 * 1024;

export function appendRotatingLogSync(
  filePath: string,
  entry: string,
  maxBytes = DEFAULT_LOG_MAX_BYTES,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const entryBytes = Buffer.byteLength(entry, "utf8");
  const currentBytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (currentBytes > 0 && currentBytes + entryBytes > maxBytes) {
    const backupPath = `${filePath}.1`;
    try { fs.unlinkSync(backupPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    fs.renameSync(filePath, backupPath);
  }
  fs.appendFileSync(filePath, entry, "utf8");
}
