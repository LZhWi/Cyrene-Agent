import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function studyWorkspaceId(root: string): string {
  return createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex");
}

/** Check existing ancestors too: a missing file below an escaping link is unsafe. */
export function studyPath(root: string, relative: string): string {
  const parts = relative.replace(/\\/g, "/").split("/");
  if (!relative || path.isAbsolute(relative) || relative.includes(":")
    || parts.some((part) => part === ".." || [".obsidian", ".git"].includes(part.toLowerCase()))) throw new Error("E_LEARN_STUDY_PATH");
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, ...parts);
  function inside(value: string) {
    const rel = path.relative(realRoot, value);
    return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
  }
  if (!inside(target)) throw new Error("E_LEARN_STUDY_PATH");
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("E_LEARN_STUDY_PATH");
    ancestor = parent;
  }
  if (!inside(fs.realpathSync(ancestor))) throw new Error("E_LEARN_STUDY_PATH");
  return target;
}
