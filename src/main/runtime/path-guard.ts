import * as fs from "node:fs";
import * as path from "node:path";

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SAFE_FILE_STEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class PathGuardError extends Error {
  constructor(
    public readonly code: "E_INVALID_FILE_STEM" | "E_PATH_OUTSIDE_ROOT",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PathGuardError";
  }
}

/** 外部 ID/stem 只能作为单个文件名片段，不能含路径、设备名或 Windows 尾部歧义。 */
export function assertSafeFileStem(value: unknown, label = "file stem"): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new PathGuardError("E_INVALID_FILE_STEM", `${label} must be a non-empty trimmed string`);
  }
  if (!SAFE_FILE_STEM.test(value) || value === "." || value === ".." || WINDOWS_RESERVED_NAME.test(value)) {
    throw new PathGuardError("E_INVALID_FILE_STEM", `${label} contains unsafe characters or a reserved name`);
  }
  return value;
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function nearestExistingPath(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * 生成 root 内的最终路径，并同时检查词法穿越和已存在 symlink 的真实路径穿越。
 * root 必须已经存在；目标本身可以尚未创建。
 */
export function resolvePathInside(root: string, ...segments: string[]): string {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(rootResolved, ...segments);
  if (!isContained(rootResolved, targetResolved)) {
    throw new PathGuardError("E_PATH_OUTSIDE_ROOT", "target escapes the configured root");
  }

  const rootReal = fs.realpathSync.native(rootResolved);
  const existingReal = fs.realpathSync.native(nearestExistingPath(targetResolved));
  if (!isContained(rootReal, existingReal)) {
    throw new PathGuardError("E_PATH_OUTSIDE_ROOT", "target resolves through a symlink outside the configured root");
  }
  return targetResolved;
}
