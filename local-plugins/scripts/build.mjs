import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zipSync } from "fflate";
import {
  CURRENT_PLUGIN_API_VERSION,
  validateManifestData,
} from "@playa0v0/cyrene-plugin-sdk";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = path.join(workspaceRoot, "plugins");
const artifactsRoot = path.join(workspaceRoot, "artifacts");
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

async function packagePlugin(pluginDirName) {
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

// 删除前确认真实路径未通过目录联接逃离本开发目录。
const { realpath } = await import("node:fs/promises");
const rootReal = await realpath(workspaceRoot);
const existingArtifacts = await lstat(artifactsRoot).catch(() => null);
if (existingArtifacts) {
  const relative = path.relative(rootReal, await realpath(artifactsRoot));
  if (existingArtifacts.isSymbolicLink() || relative !== "artifacts") throw new Error("artifacts 路径越界，拒绝删除");
}
await rm(artifactsRoot, { recursive: true, force: true });
await mkdir(artifactsRoot, { recursive: true });

const pluginDirs = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== "shared")
  .map((entry) => entry.name)
  .sort();

if (pluginDirs.length === 0) throw new Error("plugins/ 中没有可构建的插件");
for (const pluginDir of pluginDirs) await packagePlugin(pluginDir);
