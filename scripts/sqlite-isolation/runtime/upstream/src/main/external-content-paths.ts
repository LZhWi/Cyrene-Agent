import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ExternalContentPathInput {
  isPackaged: boolean;
  appPath: string;
  executablePath: string;
  userDataPath: string;
}

export interface ExternalContentPaths {
  installRoot: string;
  promptDirectories: string[];
  builtinSkillDirectory: string;
  userSkillDirectories: string[];
}

export interface SkillScanSource {
  directory: string;
  source: "builtin" | "user";
}

/**
 * Resolve editable prompt/skill locations without coupling them to app.asar.
 * Packaged builds put user-editable content under userData (survives upgrades:
 * the NSIS uninstaller wipes the whole install directory on reinstall) and read
 * shipped content from folders beside Cyrene.exe, which the installer refreshes
 * on every update. Shipped skills live directly in <install>/skills.
 */
export function resolveExternalContentPaths(input: ExternalContentPathInput): ExternalContentPaths {
  if (!input.isPackaged) {
    return {
      installRoot: input.appPath,
      promptDirectories: [path.join(input.appPath, "prompts")],
      builtinSkillDirectory: path.join(input.appPath, "skills"),
      userSkillDirectories: [path.join(input.userDataPath, "skills")],
    };
  }

  const installRoot = path.dirname(input.executablePath);
  return {
    installRoot,
    promptDirectories: [
      path.join(input.userDataPath, "prompts"),
      path.join(installRoot, "prompts"),
    ],
    // 内置技能随安装包放在 exe 同级的 skills/（安装器每次升级刷新）
    builtinSkillDirectory: path.join(installRoot, "skills"),
    userSkillDirectories: [path.join(input.userDataPath, "skills")],
  };
}

/** Resolve paths from Electron, with a repository fallback for isolated tests. */
export function getExternalContentPaths(): ExternalContentPaths {
  try {
    return resolveExternalContentPaths({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      executablePath: app.getPath("exe"),
      userDataPath: app.getPath("userData"),
    });
  } catch {
    const repository = process.cwd();
    return resolveExternalContentPaths({
      isPackaged: false,
      appPath: repository,
      executablePath: process.execPath,
      userDataPath: path.join(repository, ".cyrene-user-data"),
    });
  }
}

function safeRelativePath(relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) return null;
  return normalized;
}

/**
 * Resolve the third-party skills snapshot archive path.
 *  - Packaged: extraResources copies vendor/cyrene-skills into
 *    resources/cyrene-skills/skills-snapshot.zip (outside asar, real disk path).
 *  - Dev: repository vendor/cyrene-skills/skills-snapshot.zip.
 * Returns null when the archive is absent (e.g. build-skills-snapshot not run).
 */
export function resolveSkillsSnapshotArchivePath(
  paths: Pick<ExternalContentPaths, "installRoot"> = getExternalContentPaths(),
  options: { isPackaged?: boolean; resourcesPath?: string; existsSync?: (p: string) => boolean } = {},
): string | null {
  const isPackaged = options.isPackaged ?? app.isPackaged;
  const exists = options.existsSync ?? ((p: string) => fs.existsSync(p));
  const candidate = isPackaged
    ? path.join(options.resourcesPath ?? process.resourcesPath, "cyrene-skills", "skills-snapshot.zip")
    : path.join(paths.installRoot, "vendor", "cyrene-skills", "skills-snapshot.zip");
  return exists(candidate) ? candidate : null;
}

/** Find a prompt or prompt directory using user-first lookup order. */
export function findPromptPath(
  relativePath: string,
  promptDirectories = getExternalContentPaths().promptDirectories,
): string | null {
  const safePath = safeRelativePath(relativePath);
  if (!safePath) return null;
  for (const directory of promptDirectories) {
    const candidate = path.join(directory, safePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Find an asset under the effective skill, with user sources taking priority. */
export function findSkillPath(
  skillId: string,
  relativePath: string,
  paths: Pick<ExternalContentPaths, "builtinSkillDirectory" | "userSkillDirectories"> = getExternalContentPaths(),
): string | null {
  const safeSkillId = safeRelativePath(skillId);
  const safePath = safeRelativePath(relativePath);
  if (!safeSkillId || !safePath || safeSkillId.includes(path.sep)) return null;

  const directories = [...paths.userSkillDirectories].reverse();
  directories.push(paths.builtinSkillDirectory);
  for (const directory of directories) {
    const candidate = path.join(directory, safeSkillId, safePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** 构建低→高优先级的技能扫描来源：内置目录在前，用户目录在后（按路径去重）。 */
export function resolveSkillScanSources(
  paths: Pick<ExternalContentPaths, "builtinSkillDirectory" | "userSkillDirectories"> = getExternalContentPaths(),
): SkillScanSource[] {
  const sources: SkillScanSource[] = [];
  if (fs.existsSync(paths.builtinSkillDirectory)) {
    sources.push({ directory: paths.builtinSkillDirectory, source: "builtin" });
  }

  const seen = new Set(sources.map((entry) => path.resolve(entry.directory).toLowerCase()));
  for (const directory of paths.userSkillDirectories) {
    const key = path.resolve(directory).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ directory, source: "user" });
  }
  return sources;
}
