// 手机图片的内容寻址 blob 存储：userData/mobile-blobs/<sha256>.<ext>
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { getUserDataDir } from "../runtime/runtime-paths";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function mimeToExt(mime: string): string {
  return MIME_EXT[mime] ?? "bin";
}

export function extToMime(ext: string): string {
  const found = Object.entries(MIME_EXT).find(([, e]) => e === ext);
  return found ? found[0] : "application/octet-stream";
}

function blobsDir(): string {
  return path.join(getUserDataDir(), "mobile-blobs");
}

/** 写入 blob（按内容哈希命名，已存在则跳过）。返回 { hash, ext }。 */
export function saveBlob(buf: Buffer, mime: string): { hash: string; ext: string } {
  const hash = createHash("sha256").update(buf).digest("hex");
  const ext = mimeToExt(mime);
  const dir = blobsDir();
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${hash}.${ext}`);
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, buf);
  return { hash, ext };
}

/** 由 hash 找回 blob 绝对路径（防穿越）。找不到返回 null。 */
export function resolveBlobPath(hash: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const dir = blobsDir();
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`${hash}.`)) return path.join(dir, name);
    }
  } catch {
    /* dir 不存在 */
  }
  return null;
}
