import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceEntry, WorkspaceFileView } from "../../shared/workspace-inspector";

export async function resolveInspectorPath(root: string, relative: string): Promise<string> {
  if (typeof relative !== "string" || path.isAbsolute(relative) || relative.includes("\0")) throw new Error("无效的工作区相对路径");
  const canonicalRoot = await fs.realpath(root);
  const target = await fs.realpath(path.resolve(canonicalRoot, relative));
  const inside = path.relative(canonicalRoot, target);
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) throw new Error("文件不在当前工作区内");
  return target;
}

export async function listInspectorFiles(root: string, relative: string, offset = 0): Promise<{ entries: WorkspaceEntry[]; hasMore: boolean }> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("无效分页");
  const target = await resolveInspectorPath(root, relative);
  const entries = (await fs.readdir(target, { withFileTypes: true }))
    .filter((entry) => ![".git", "node_modules"].includes(entry.name) && !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return { entries: entries.slice(offset, offset + 200).map((entry) => ({ name: entry.name,
    path: path.join(relative, entry.name).replace(/\\/g, "/"), directory: entry.isDirectory() })), hasMore: entries.length > offset + 200 };
}

export async function readInspectorFile(root: string, relative: string): Promise<WorkspaceFileView> {
  const file = await resolveInspectorPath(root, relative);
  const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, string>)[path.extname(file).toLowerCase()];
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const limit = mime ? 8 * 1024 * 1024 : 512 * 1024;
    if (!stat.isFile() || stat.size > limit) throw new Error("文件过大，或不支持预览；请在工作区打开");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("文件过大，无法预览");
    const bytes = buffer.subarray(0, length);
    if (mime) return { kind: "image", dataUrl: `data:${mime};base64,${bytes.toString("base64")}` };
    if (bytes.includes(0)) throw new Error("二进制文件不支持文本预览");
    return { kind: "text", content: bytes.toString("utf8") };
  } finally { await handle.close(); }
}
