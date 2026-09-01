import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CyrenePlugin, PluginManifest, PluginRecord } from "./types";

const MANIFEST_FILE = "manifest.json";
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DEPS_ALLOWED = new Set(["channels", "llm"]);
const ENTRY_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

/** 读取并校验 manifest；不合法返回 null（调用方跳过并留痕日志） */
export function readManifest(dir: string): PluginManifest | null {
  const manifestPath = path.join(dir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
    if (!raw || typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
    if (typeof raw.name !== "string" || !raw.name) return null;
    if (typeof raw.version !== "string" || !raw.version) return null;
    if (typeof raw.description !== "string" || !raw.description) return null;
    if (typeof raw.author !== "string" || !raw.author) return null;
    if (typeof raw.entry !== "string" || !raw.entry) return null;
    // entry 必须是目录内的裸文件名，拒绝 ../ 或子目录穿越
    if (path.basename(raw.entry) !== raw.entry) return null;
    if (!ENTRY_EXTENSIONS.has(path.extname(raw.entry).toLowerCase())) return null;
    if (!existsSync(path.join(dir, raw.entry))) return null;
    return {
      id: raw.id,
      name: raw.name,
      version: raw.version,
      description: raw.description,
      author: raw.author,
      entry: raw.entry,
      defaultEnabled: raw.defaultEnabled !== false,
      deps: Array.isArray(raw.deps)
        ? raw.deps.filter(
            (d): d is "channels" | "llm" =>
              typeof d === "string" && DEPS_ALLOWED.has(d),
          )
        : undefined,
    };
  } catch {
    return null;
  }
}

/** 扫描 root 下所有一级子目录，收集带合法 manifest 的插件 */
export function scanPluginDir(root: string): PluginRecord[] {
  if (!existsSync(root)) return [];
  const out: PluginRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifest = readManifest(dir);
    if (!manifest) {
      console.warn(`[plugins] 忽略无效插件目录: ${dir}`);
      continue;
    }
    out.push({ manifest, dir });
  }
  return out;
}

/** 动态加载插件入口（.cjs/.js/.mjs 均可），归一化 default/named export */
export async function loadPlugin(record: PluginRecord): Promise<CyrenePlugin> {
  const entry = path.join(record.dir, record.manifest.entry);
  const ext = path.extname(entry).toLowerCase();
  let mod: Record<string, unknown>;
  if (ext === ".mjs") {
    // commonjs 编译会把 import() 改写为 require()，require 无法加载 file:// URL，
    // 因此 ESM 入口经运行时 import 加载（new Function 避开 tsc 改写）。
    const dynamicImport = new Function(
      "specifier",
      "return import(specifier)",
    ) as (specifier: string) => Promise<Record<string, unknown>>;
    mod = await dynamicImport(pathToFileURL(entry).href);
  } else {
    mod = require(entry) as Record<string, unknown>;
  }
  const plugin = (mod.default ?? mod) as Partial<CyrenePlugin>;
  if (typeof plugin.register !== "function") {
    throw new Error(`插件 ${record.manifest.id} 入口未导出 register()`);
  }
  return plugin as CyrenePlugin;
}
