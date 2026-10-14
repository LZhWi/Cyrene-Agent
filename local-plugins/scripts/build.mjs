import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zipSync } from "fflate";
import { CURRENT_PLUGIN_API_VERSION } from "../../packages/plugin-sdk/dist/api.js";
import { validateManifestData } from "../../packages/plugin-sdk/dist/validate-manifest.js";
import { getArtifactRoot } from "./artifact-root.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEDICATED_BUILDERS = new Set(["codex-bridge", "cyrene-hud", "dungeons-decision", "dungeons-input", "furina-file-tools", "minecraft-body"]);
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const ICON_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg"]);
const LOCAL_HOST_CAPABILITIES = new Set(["assistant-delivery", "screen-observation", "user-presence", "proactive-documents"]);

// 本地宿主接口先于公开 SDK 发布时，仅剥离明确登记的扩展能力交给旧 SDK 校验；
// 其余 manifest 字段和依赖仍由公开 SDK 严格验证，打包时保留真实 deps。
function validateDevelopmentManifest(raw) {
  const sdkInput = Array.isArray(raw?.deps)
    ? { ...raw, deps: raw.deps.filter((dep) => !LOCAL_HOST_CAPABILITIES.has(dep)) }
    : raw;
  const validation = validateManifestData(sdkInput);
  if (validation.ok && validation.value && Array.isArray(raw?.deps)) {
    validation.value.deps = [...raw.deps];
  }
  return validation;
}

async function collectFiles(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`构建目录不允许符号链接: ${absolute}`);
    }
    if (entry.isDirectory()) result.push(...await collectFiles(root, absolute));
    else if (entry.isFile()) result.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return result;
}

async function packagePlugin(pluginDirName, pluginsRoot, artifactsRoot) {
  const sourceDir = path.join(pluginsRoot, pluginDirName);
  const manifestPath = path.join(sourceDir, "manifest.json");
  const readmePath = path.join(sourceDir, "README.md");
  const manifestRaw = JSON.parse(await readFile(manifestPath, "utf8"));
  const validation = validateDevelopmentManifest(manifestRaw);
  if (!validation.ok || !validation.value) {
    throw new Error(`${pluginDirName} manifest 无效: ${validation.error ?? "未知错误"}`);
  }

  const manifest = validation.value;
  if (manifest.apiVersion !== CURRENT_PLUGIN_API_VERSION) {
    throw new Error(`${pluginDirName} apiVersion 与当前 SDK 不兼容`);
  }
  if (!ID_RE.test(manifest.id)) throw new Error(`${pluginDirName} id 不符合小写连字符格式`);
  if (manifest.id !== pluginDirName) {
    throw new Error(`${pluginDirName} 目录名必须与 manifest.id (${manifest.id}) 一致`);
  }
  if (!manifest.name.trim() || !manifest.description.trim() || !manifest.author.trim()) {
    throw new Error(`${manifest.id} 的 name、description、author 不能为空`);
  }
  if (!SEMVER_RE.test(manifest.version)) throw new Error(`${manifest.id} version 不是合法 SemVer`);
  if (manifest.entry !== "index.cjs") {
    throw new Error(`${manifest.id} 的 entry 必须为 index.cjs`);
  }

  const sourceEntry = path.join(sourceDir, "src", "index.ts");
  const sourceEntryStat = await lstat(sourceEntry);
  if (!sourceEntryStat.isFile() || sourceEntryStat.isSymbolicLink()) {
    throw new Error(`${manifest.id} 的 src/index.ts 必须是普通文件`);
  }
  const readmeStat = await lstat(readmePath);
  if (!readmeStat.isFile() || readmeStat.isSymbolicLink()) {
    throw new Error(`${manifest.id} 的 README.md 必须是普通文件`);
  }

  const outputDir = path.join(artifactsRoot, manifest.id);
  await mkdir(outputDir, { recursive: true });
  await build({
    entryPoints: [sourceEntry],
    outfile: path.join(outputDir, manifest.entry),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node24",
    external: ["electron"],
    logLevel: "silent",
  });
  await cp(manifestPath, path.join(outputDir, "manifest.json"));
  await cp(readmePath, path.join(outputDir, "README.md"));

  const staticDir = path.join(sourceDir, "static");
  const staticStat = await lstat(staticDir).catch(() => null);
  if (staticStat?.isSymbolicLink()) throw new Error(`${manifest.id} 的 static 目录不能是符号链接`);
  if (staticStat?.isDirectory()) {
    await cp(staticDir, outputDir, { recursive: true });
  }

  const personaDir = path.join(sourceDir, "persona");
  const personaStat = await lstat(personaDir).catch(() => null);
  if (personaStat?.isSymbolicLink()) throw new Error(`${manifest.id} 的 persona 目录不能是符号链接`);
  if (personaStat?.isDirectory()) {
    await cp(personaDir, path.join(outputDir, "persona"), { recursive: true });
  }

  const worldbookDir = path.join(sourceDir, "worldbook");
  const worldbookStat = await lstat(worldbookDir).catch(() => null);
  if (worldbookStat?.isSymbolicLink()) throw new Error(`${manifest.id} 的 worldbook 目录不能是符号链接`);
  if (worldbookStat?.isDirectory()) {
    await cp(worldbookDir, path.join(outputDir, "worldbook"), { recursive: true });
  }

  if (manifest.icon) {
    if (path.basename(manifest.icon) !== manifest.icon || !ICON_EXTENSIONS.has(path.extname(manifest.icon).toLowerCase())) {
      throw new Error(`${manifest.id} icon 必须是受支持扩展名的裸文件名`);
    }
    const iconStat = await lstat(path.join(outputDir, manifest.icon)).catch(() => null);
    if (!iconStat?.isFile() || iconStat.isSymbolicLink() || iconStat.size > 2 * 1024 * 1024) {
      throw new Error(`${manifest.id} icon 缺失、不是普通文件或超过 2 MiB`);
    }
  }

  const builtEntry = await readFile(path.join(outputDir, manifest.entry), "utf8");
  if (builtEntry.includes("@playa0v0/cyrene-plugin-sdk")) {
    throw new Error(`${manifest.id} 产物仍包含 SDK 运行时依赖；SDK 导入必须仅用于类型`);
  }

  const files = await collectFiles(outputDir);
  const zipEntries = {};
  let totalSize = 0;
  for (const relative of files) {
    const data = new Uint8Array(await readFile(path.join(outputDir, relative)));
    totalSize += data.byteLength;
    zipEntries[`${manifest.id}/${relative}`] = data;
  }
  if (files.length > 2000) throw new Error(`${manifest.id} 文件数超过宿主上限 2000`);
  if (totalSize > 200 * 1024 * 1024) throw new Error(`${manifest.id} 解压总量超过宿主上限 200 MiB`);

  const archive = zipSync(zipEntries, { level: 9 });
  if (archive.byteLength > 50 * 1024 * 1024) {
    throw new Error(`${manifest.id} ZIP 超过宿主上限 50 MiB`);
  }
  await writeFile(path.join(artifactsRoot, `${manifest.id}.zip`), archive);
  console.log(`[build] ${manifest.id}: ${files.length} 个文件，ZIP ${archive.byteLength} bytes`);
}

async function publishArtifacts(staged, artifactsRoot) {
  const names = await readdir(staged);
  // 在移动任何旧产物前检查所有替换目标，拒绝目录联接和文件链接。
  for (const name of names) {
    const destination = path.join(artifactsRoot, name);
    const existing = await lstat(destination).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existing && (existing.isSymbolicLink() || await realpath(destination) !== destination)) {
      throw new Error(`产物目标不能是链接: ${destination}`);
    }
  }
  const backup = path.join(staged, ".previous");
  await mkdir(backup);
  const moved = [];
  try {
    for (const name of names) {
      const entry = { name, backedUp: false, installed: false };
      moved.push(entry);
      try {
        await rename(path.join(artifactsRoot, name), path.join(backup, name));
        entry.backedUp = true;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await rename(path.join(staged, name), path.join(artifactsRoot, name));
      entry.installed = true;
    }
  } catch (error) {
    try {
      for (const entry of moved.reverse()) {
        if (entry.installed) await rename(path.join(artifactsRoot, entry.name), path.join(staged, entry.name));
        if (entry.backedUp) await rename(path.join(backup, entry.name), path.join(artifactsRoot, entry.name));
      }
    } catch (rollbackError) {
      const failure = new AggregateError([error, rollbackError], `恢复失败，旧产物保留在 ${backup}`);
      failure.recoveryDirectory = staged;
      throw failure;
    }
    throw error;
  }
}

export async function buildPlugins({ root = workspaceRoot, dependencySource } = {}) {
  const pluginsRoot = path.join(root, "plugins");
  const artifactsRoot = await getArtifactRoot(root);
  const pluginDirs = (await readdir(pluginsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "shared")
    .map((entry) => entry.name)
    .sort();
  if (pluginDirs.length === 0) throw new Error("plugins/ 中没有可构建的插件");
  const staged = await mkdtemp(path.join(artifactsRoot, ".build-"));
  let preserveRecovery = false;
  try {
    for (const pluginDir of pluginDirs) {
      if (DEDICATED_BUILDERS.has(pluginDir)) {
        const args = [path.join(root, "scripts", `build-${pluginDir}.mjs`)];
        if (pluginDir === "minecraft-body" && dependencySource) args.push("--dependency-source", path.resolve(dependencySource));
        execFileSync(process.execPath, args, {
          cwd: root, windowsHide: true, stdio: "inherit",
          env: { ...process.env, CYRENE_PLUGIN_ARTIFACTS_ROOT: staged },
        });
      } else await packagePlugin(pluginDir, pluginsRoot, staged);
    }
    await publishArtifacts(staged, artifactsRoot);
  } catch (error) {
    preserveRecovery = Boolean(error.recoveryDirectory);
    throw error;
  } finally {
    // 仅删除本次新建且边界已确认的暂存目录；不清空 artifacts。
    if (path.dirname(staged) !== artifactsRoot || await realpath(staged) !== staged) throw new Error("暂存目录边界校验失败");
    if (!preserveRecovery) await rm(staged, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--dependency-source")) throw new Error("使用 --dependency-source <Minecraft node_modules目录>");
  await buildPlugins({ dependencySource: args[1] });
}
