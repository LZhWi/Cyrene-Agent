/**
 * Cline 适配层 - workspaceRoot 边界检查
 *
 * 安全约束：
 * - realpath 解析（跟随 symlink/junction）
 * - 目标不存在时 realpath 最近存在的父目录
 * - `..` 路径逃逸检测
 * - workspaceRoot 优先来自可信 ToolContext
 */

import * as fs from "fs";
import * as path from "path";

/**
 * 检查文件路径是否在 workspaceRoot 内。
 * 目标不存在时 realpath 最近存在的父目录，再检查目标路径是否仍在 workspaceRoot 内。
 */
export function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  if (!filePath || !path.isAbsolute(filePath)) return false;

  const normalizedRoot = path.normalize(workspaceRoot);

  // 尝试 realpath 目标文件
  let resolvedFile: string | null = null;
  try {
    resolvedFile = fs.realpathSync(filePath);
  } catch {
    // 目标不存在，realpath 最近存在的父目录
    resolvedFile = resolveNearestExisting(filePath);
    if (!resolvedFile) return false;

    // 检查不存在的目标路径是否仍在 workspaceRoot 内
    // 用 resolvedFile（父目录）+ 剩余路径做路径检查
    const relativeToParent = path.relative(path.dirname(resolvedFile), filePath);
    const projectedPath = path.join(resolvedFile, relativeToParent);
    const normalizedProjected = path.normalize(projectedPath);
    if (normalizedProjected === normalizedRoot) return false;
    return normalizedProjected.startsWith(normalizedRoot + path.sep);
  }

  // 目标存在，直接比较
  const normalizedFile = path.normalize(resolvedFile);
  if (normalizedFile === normalizedRoot) return false;
  return normalizedFile.startsWith(normalizedRoot + path.sep);
}

/**
 * 向上查找最近存在的父目录并返回其 realpath。
 */
function resolveNearestExisting(filePath: string): string | null {
  let current = path.dirname(filePath);
  for (let i = 0; i < 20; i++) { // 最多向上 20 层
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null; // 到达根
      current = parent;
    }
  }
  return null;
}

/**
 * 规范化 workspaceRoot 并返回 realpath。
 * 用于 workspace 锁的 key。
 */
export function normalizeWorkspaceRoot(workspaceRoot: string): string {
  try {
    return path.normalize(fs.realpathSync(workspaceRoot));
  } catch {
    // workspaceRoot 不存在时直接 normalize
    return path.normalize(workspaceRoot);
  }
}
