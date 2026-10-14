import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describePendingAttachment } from "../rag/file-ingest";

export async function describeClipboardFileUris(uriList: string) {
  const attachments: ReturnType<typeof describePendingAttachment>[] = [];
  const seen = new Set<string>();
  for (const line of uriList.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    let filePath: string;
    try {
      const url = new URL(line.trim());
      if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) continue;
      filePath = fileURLToPath(url);
      const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
      if (seen.has(key) || !(await stat(filePath)).isFile()) continue;
      seen.add(key);
    } catch { continue; }
    attachments.push(describePendingAttachment(filePath));
  }
  return attachments;
}
