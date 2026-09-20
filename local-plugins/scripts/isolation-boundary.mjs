import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RUN_NAMES = new Set(["full-electron-host", "visible-electron-host"]);
const RUN_ID = /^run-\d+-[0-9a-f-]{36}$/;

/** 从原工作树或嵌套上游工作树定位真正的项目容器与正式版兄弟目录。 */
export function resolveProjectLayout(projectRoot) {
  const root = path.resolve(projectRoot);
  const container = path.basename(root) === ".upstream-latest" ? path.dirname(root) : root;
  if (path.basename(container) !== "Cyrene-Agent-N") {
    throw new Error("隔离入口不在 Cyrene-Agent-N 或其最新上游工作树内");
  }
  return {
    projectContainerRoot: container,
    originalProjectRoot: path.join(path.dirname(container), "Cyrene-Agent"),
  };
}

function assertPlainDirectory(dir) {
  const entry = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`隔离目录不存在或不是普通目录: ${dir}`);
  }
}

function ensurePlainChild(parent, name) {
  if (!name || name === "." || name === ".." || path.basename(name) !== name) {
    throw new Error(`非法隔离目录名: ${name}`);
  }
  assertPlainDirectory(parent);
  const child = path.join(parent, name);
  const entry = fs.lstatSync(child, { throwIfNoEntry: false });
  if (!entry) fs.mkdirSync(child);
  assertPlainDirectory(child);
  return child;
}

export function createRunDirectory(localRoot, runName) {
  const projectRoot = path.dirname(localRoot);
  const { projectContainerRoot } = resolveProjectLayout(projectRoot);
  const latestWorktree = projectContainerRoot !== projectRoot;
  if (!RUN_NAMES.has(runName)) {
    throw new Error("隔离入口必须位于 Cyrene-Agent-N 或其 .upstream-latest 工作树的 local-plugins");
  }
  assertPlainDirectory(projectRoot);
  if (latestWorktree) assertPlainDirectory(path.dirname(projectRoot));
  assertPlainDirectory(localRoot);
  const runtime = ensurePlainChild(localRoot, ".test-runtime");
  const parent = ensurePlainChild(runtime, runName);
  return ensurePlainChild(parent, `run-${Date.now()}-${crypto.randomUUID()}`);
}

export function assertRunDirectory(localRoot, runName, runRoot) {
  if (!RUN_NAMES.has(runName) || !RUN_ID.test(path.basename(runRoot))) {
    throw new Error("非法隔离运行目录");
  }
  const expectedParent = path.join(localRoot, ".test-runtime", runName);
  if (path.resolve(path.dirname(runRoot)).toLowerCase() !== path.resolve(expectedParent).toLowerCase()) {
    throw new Error(`隔离运行目录越界: ${runRoot}`);
  }
  for (const dir of [path.dirname(localRoot), localRoot, path.join(localRoot, ".test-runtime"), expectedParent, runRoot]) {
    assertPlainDirectory(dir);
  }
}

export function ensureRunSubdirectory(runRoot, relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]+/).some((part) => !part || part === "." || part === "..")) {
    throw new Error(`隔离子目录越界: ${relative}`);
  }
  return relative.split(/[\\/]+/).reduce(ensurePlainChild, runRoot);
}

export function createChildEnvironment(baseEnv, runRoot, visible) {
  const home = path.join(runRoot, "home");
  const temp = path.join(runRoot, "temp");
  const hfHome = path.join(home, ".cache", "huggingface");
  return {
    ...baseEnv,
    APPDATA: path.join(runRoot, "app-data"),
    LOCALAPPDATA: path.join(runRoot, "local-app-data"),
    USERPROFILE: home,
    HOME: home,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    HF_HOME: hfHome,
    HUGGINGFACE_HUB_CACHE: path.join(hfHome, "hub"),
    TRANSFORMERS_CACHE: path.join(hfHome, "transformers"),
    npm_config_cache: path.join(runRoot, "npm-cache"),
    CYRENE_ISOLATED_RUN_ROOT: runRoot,
    CYRENE_ISOLATED_VISIBLE: visible ? "1" : "0",
  };
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** 仅在内存中保留相对路径、元数据与哈希；任何不可读项都会阻止启动。 */
export function snapshotTree(root, { contentOnly = false } = {}) {
  if (!path.isAbsolute(root)) throw new Error(`受保护目录不是绝对路径: ${root}`);
  const entries = [];
  const pending = [[root, "."]];
  while (pending.length > 0) {
    const [current, relative] = pending.pop();
    let stat;
    try {
      stat = fs.lstatSync(current, { throwIfNoEntry: false });
    } catch (error) {
      throw new Error(`受保护数据无法读取元数据: ${relative} (${error?.code ?? "unknown"})`, { cause: error });
    }
    if (!stat) {
      entries.push([relative, "missing"]);
      continue;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`受保护数据含链接，无法完整校验: ${relative}`);
    } else if (stat.isDirectory()) {
      entries.push(contentOnly ? [relative, "dir"] : [relative, "dir", stat.mtimeMs, stat.ctimeMs]);
      let names;
      try {
        names = fs.readdirSync(current).sort().reverse();
      } catch (error) {
        throw new Error(`受保护数据目录无法枚举: ${relative} (${error?.code ?? "unknown"})`, { cause: error });
      }
      for (const name of names) {
        pending.push([path.join(current, name), path.join(relative, name)]);
      }
    } else if (stat.isFile()) {
      let digest;
      try {
        digest = hashFile(current);
      } catch (error) {
        throw new Error(`受保护数据文件无法只读校验: ${relative} (${error?.code ?? "unknown"})`, { cause: error });
      }
      entries.push(contentOnly
        ? [relative, "file", stat.size, digest]
        : [relative, "file", stat.size, stat.mtimeMs, stat.ctimeMs, digest]);
    } else {
      entries.push([relative, "other", stat.size, stat.mtimeMs, stat.ctimeMs]);
    }
  }
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
