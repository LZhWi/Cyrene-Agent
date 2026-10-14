// Dedicated build: never invokes the shared builder or rebuilds other plugins.
import { build } from "esbuild";
import { zipSync, unzipSync } from "fflate";
import { cp, mkdir, readFile, writeFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateManifestData } from "@playa0v0/cyrene-plugin-sdk";
import { getArtifactRoot } from "./artifact-root.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "plugins", "minecraft-body");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--dependency-source")) throw new Error("使用 --dependency-source <node_modules目录>");
const modules = await realpath(args[1] || path.join(source, "runtime", "node_modules"));
const temporary = path.join(root, ".test-runtime", `minecraft-body-build-${randomUUID()}`);
const staged = path.join(temporary, "minecraft-body");
const artifactRoot = await getArtifactRoot(root);
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
const validation = validateManifestData(manifest);
if (!validation.ok) throw new Error(validation.error);

const packages = new Map();
async function dependency(name, resolver, optional = false) {
  let entry;
  try { entry = resolver.resolve(`${name}/package.json`); }
  catch {
    try {
      let dir = path.dirname(resolver.resolve(name));
      while (true) {
        try { await stat(path.join(dir, "package.json")); entry = path.join(dir, "package.json"); break; } catch {}
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error(`缺少 ${name}`);
        dir = parent;
      }
    } catch (error) { if (optional) return; throw error; }
  }
  entry = await realpath(entry);
  if (packages.has(entry)) return;
  const relative = path.relative(modules, path.dirname(entry));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`依赖 ${name} 不在指定 node_modules 中`);
  const pkg = JSON.parse(await readFile(entry, "utf8"));
  packages.set(entry, { name: pkg.name, version: pkg.version, relative });
  const next = createRequire(entry);
  for (const name of Object.keys(pkg.dependencies || {})) await dependency(name, next);
  for (const name of Object.keys(pkg.optionalDependencies || {})) {
    // typed-emitter 2.1.0 references RxJS only from .d.ts declarations. Its
    // runtime entry and rxjs entry are empty stubs; no executable import exists.
    if (pkg.name === "typed-emitter" && pkg.version === "2.1.0" && name === "rxjs") continue;
    await dependency(name, next, true);
  }
}

const resolver = createRequire(path.join(modules, "..", "package.json"));
const pinned = JSON.parse(await readFile(path.join(source, "runtime", "package.json"), "utf8"));
for (const name of Object.keys(pinned.dependencies)) await dependency(name, resolver);
for (const [name, version] of Object.entries(pinned.dependencies)) {
  if (![...packages.values()].some((pkg) => pkg.name === name && pkg.version === version)) throw new Error(`${name} 需要 ${version}`);
}

const excluded = new Set(["node_modules", ".git", ".github", "test", "tests", "examples", "example", "docs", "doc", "coverage", "benchmark", "benchmarks", "fixtures"]);
function keep(relative) {
  const parts = relative.split(path.sep);
  if (parts.some((part) => excluded.has(part))) return false;
  const basename = parts.at(-1);
  if (/\.test\.cjs$|\.(?:ts|map)$/.test(basename)) return false;
  if (/\.md$/i.test(basename) && !/license|licence|notice|copyright/i.test(basename)) return false;
  // Mineflayer is Java-only. minecraft-data imports common Bedrock metadata at
  // module load, so retain common; remove only Bedrock version payloads.
  const bedrock = parts.indexOf("bedrock");
  if (parts.includes("data") && bedrock >= 0 && parts[bedrock + 1] && parts[bedrock + 1] !== "common") return false;
  return true;
}

async function copyRuntimePackage(from, to, relative = "") {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (!keep(next)) continue;
    if (entry.isSymbolicLink()) throw new Error(`发布依赖不能包含链接：${next}`);
    if (entry.isDirectory()) await copyRuntimePackage(path.join(from, entry.name), path.join(to, entry.name), next);
    else if (entry.isFile()) {
      await mkdir(to, { recursive: true });
      await cp(path.join(from, entry.name), path.join(to, entry.name));
    }
  }
}

async function files(directory, relative = "") {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), next));
    else result.push(next);
  }
  return result;
}

try {
  await mkdir(staged, { recursive: true });
  await build({ entryPoints: [path.join(source, "src", "index.ts")], outfile: path.join(staged, "index.cjs"),
    bundle: true, format: "cjs", platform: "node", target: "node24", logLevel: "silent" });
  for (const file of ["manifest.json", "README.md"]) await cp(path.join(source, file), path.join(staged, file));
  await cp(path.join(source, "static"), staged, { recursive: true });
  // Explicit runtime files: never sweep local caches/configuration into a ZIP.
  for (const file of ["body.cjs", "common-actions.cjs", "sidecar.cjs", "package.json", "legacy/commands.cjs", "legacy/safety.cjs", "legacy/tools.cjs", "legacy/environment.cjs", "legacy/LICENSE"]) {
    const destination = path.join(staged, "runtime", file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(source, "runtime", file), destination);
  }
  for (const [entry, pkg] of packages) {
    await copyRuntimePackage(path.dirname(entry), path.join(staged, "runtime", "node_modules", pkg.relative));
  }
  await writeFile(path.join(staged, "runtime", "dependency-versions.json"), JSON.stringify([...packages.values()].sort((a, b) => a.name.localeCompare(b.name)), null, 2));

  // Load solely from staged dependencies; no server, model or authentication call.
  const smoke = `const r=require('./runtime/node_modules/mineflayer');const d=require('./runtime/node_modules/minecraft-data');require('./runtime/node_modules/mineflayer-pathfinder');require('./runtime/node_modules/prismarine-auth');require('./runtime/body.cjs');for(const v of r.testedVersions){const x=d(v);if(!x?.blocksArray?.length||!x.protocol)throw Error('Missing Java data: '+v)}console.log(JSON.stringify({versions:r.testedVersions.length,microsoftAuth:require('./runtime/node_modules/prismarine-auth/package.json').version}));`;
  console.log(execFileSync(process.execPath, ["-e", smoke], { cwd: staged, env: { ...process.env, NODE_PATH: "" }, encoding: "utf8" }).trim());
  const entries = {};
  let bytes = 0;
  for (const file of await files(staged)) {
    const data = new Uint8Array(await readFile(path.join(staged, file)));
    entries[`minecraft-body/${file.split(path.sep).join("/")}`] = data;
    bytes += data.length;
  }
  if (Object.keys(entries).length > 2000 || bytes > 200 * 1024 * 1024) throw new Error(`插件超出宿主解包限制：${Object.keys(entries).length}文件，${bytes}字节`);
  const zip = zipSync(entries, { level: 9 });
  if (zip.length > 50 * 1024 * 1024) throw new Error("ZIP 超过 50 MiB");
  const extracted = unzipSync(zip);
  for (const [name, data] of Object.entries(entries)) {
    if (!extracted[name] || !Buffer.from(data).equals(Buffer.from(extracted[name]))) throw new Error(`ZIP 校验失败：${name}`);
  }
  await mkdir(artifactRoot, { recursive: true });
  const actualArtifacts = await realpath(artifactRoot);
  if (actualArtifacts !== artifactRoot) throw new Error("artifacts 目录不能是链接");
  const destination = path.join(actualArtifacts, "minecraft-body");
  try { if (await realpath(destination) !== destination) throw new Error("目标插件目录不能是链接"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Verified absolute path, restricted to this plugin's output.
  await rm(destination, { recursive: true, force: true });
  await cp(staged, destination, { recursive: true });
  const zipPath = path.join(actualArtifacts, "minecraft-body.zip");
  try { if (await realpath(zipPath) !== zipPath) throw new Error("ZIP 目标不能是链接"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await writeFile(zipPath, zip);
  console.log(JSON.stringify({ zip: zipPath, files: Object.keys(entries).length, unpackedBytes: bytes,
    zipBytes: zip.length, sha256: createHash("sha256").update(zip).digest("hex") }, null, 2));
} finally {
  // temporary is a fresh UUID directory created only by this invocation.
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.join(root, ".test-runtime")) throw new Error("临时目录边界校验失败");
  await rm(resolved, { recursive: true, force: true });
}
