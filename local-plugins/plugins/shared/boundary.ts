import path from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** 将宿主分配给本插件的私有存储目录解析为真实路径。 */
export function resolvePluginStorageRoot(candidate: string): string {
  if (!path.isAbsolute(candidate) || !existsSync(candidate) || !lstatSync(candidate).isDirectory()) {
    throw new Error("插件私有存储目录无效");
  }
  return realpathSync(candidate);
}

/** 只允许访问插件私有存储目录直属的普通状态文件，并拒绝链接逃逸。 */
export function assertPluginStorageFile(root: string, candidate: string): void {
  const parent = realpathSync(path.dirname(candidate));
  const canonicalCandidate = path.resolve(parent, path.basename(candidate));
  if (!isInside(root, canonicalCandidate) || path.relative(root, parent) !== "") {
    throw new Error("插件状态文件必须位于本插件私有存储目录");
  }
  if (existsSync(candidate)) {
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || !isInside(root, realpathSync(candidate))) {
      throw new Error("插件状态文件必须是私有存储目录内的普通文件");
    }
  }
}
