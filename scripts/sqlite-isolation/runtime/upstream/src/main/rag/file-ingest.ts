import * as path from "path";
import { pathToFileURL } from "url";

export const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]);

const UNSUPPORTED_EXTS = new Set([
  ".zip", ".7z", ".rar", ".tar", ".gz", ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".ppt", ".pptx", ".ico", ".mp3", ".mp4", ".wav", ".avi", ".mov", ".exe", ".dll",
  ".so", ".dylib", ".bin", ".class", ".jar", ".pyc", ".o", ".a", ".wasm",
]);

export type PendingAttachmentDescription =
  | { name: string; kind: "document"; filePath: string; status: "pending" }
  | { name: string; kind: "image"; filePath: string; mime: string; status: "pending"; previewUrl: string }
  | { name: string; kind: "unsupported"; filePath: string; status: "error"; reason: string };

export function isImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase());
}

export function getMimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".bmp": return "image/bmp";
    case ".webp": return "image/webp";
    default: return "application/octet-stream";
  }
}

/** 登记附件路径供对话工具读取；这里不读取文件内容，也不建立索引。 */
export function describePendingAttachment(filePath: string, mime?: string): PendingAttachmentDescription {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  if (isImageExt(ext) || (typeof mime === "string" && mime.startsWith("image/"))) {
    return {
      name,
      kind: "image",
      filePath,
      mime: isImageExt(ext) ? getMimeFromExt(ext) : (mime ?? getMimeFromExt(ext)),
      previewUrl: pathToFileURL(filePath).toString(),
      status: "pending",
    };
  }
  if (UNSUPPORTED_EXTS.has(ext)) {
    return {
      name,
      kind: "unsupported",
      filePath,
      status: "error",
      reason: `暂不支持的文件格式 ${ext || "（无扩展名）"}`,
    };
  }
  return { name, kind: "document", filePath, status: "pending" };
}
