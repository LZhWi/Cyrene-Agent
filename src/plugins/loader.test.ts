import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugin, readManifest, scanPluginDir } from "./loader";

let tmp: string;

function fixture(rel: string, files: Record<string, string>): string {
  if (!tmp) tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-plugins-test-"));
  const dir = path.join(tmp, rel);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

const validManifest = {
  apiVersion: 1,
  id: "demo",
  name: "演示",
  version: "1.0.0",
  description: "d",
  author: "a",
  entry: "index.cjs",
  defaultEnabled: true,
};

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

describe("readManifest", () => {
  it("读取合法 manifest", () => {
    const dir = fixture("ok", {
      "manifest.json": JSON.stringify(validManifest),
      "index.cjs": "module.exports = {};",
    });
    expect(readManifest(dir)).toMatchObject({ id: "demo" });
  });

  it("拒绝非法 id 或缺失入口文件", () => {
    const dir = fixture("bad", {
      "manifest.json": JSON.stringify({ ...validManifest, id: "Bad ID", entry: "nope.js" }),
    });
    expect(readManifest(dir)).toBeNull();
  });

  it("无 manifest 返回 null", () => {
    const dir = fixture("empty", { "readme.txt": "x" });
    expect(readManifest(dir)).toBeNull();
  });

  it("拒绝带路径的 entry（防目录穿越）", () => {
    const dir = fixture("bad-entry-path", {
      "manifest.json": JSON.stringify({ ...validManifest, entry: "sub/index.js" }),
    });
    expect(readManifest(dir)).toBeNull();
  });

  it("拒绝非 JavaScript 入口", () => {
    const dir = fixture("bad-entry-extension", {
      "manifest.json": JSON.stringify({ ...validManifest, entry: "payload.json" }),
      "payload.json": "{}",
    });
    expect(readManifest(dir)).toBeNull();
  });

  it("拒绝未知 deps，而不是静默过滤拼写错误", () => {
    const dir = fixture("bad-deps", {
      "manifest.json": JSON.stringify({ ...validManifest, deps: ["channels", "llm", "nope"] }),
      "index.cjs": `module.exports = { register() {} };`,
    });
    expect(readManifest(dir)).toBeNull();
  });

  it("接受八项扩展能力作为 deps", () => {
    const dir = fixture("new-deps", {
      "manifest.json": JSON.stringify({
        ...validManifest,
        deps: ["secrets", "workspace", "conversations", "assistant-delivery", "screen-observation", "user-presence", "scheduler", "speech-input"],
      }),
      "index.cjs": `module.exports = { register() {} };`,
    });
    expect(readManifest(dir)?.deps).toEqual([
      "secrets",
      "workspace",
      "conversations",
      "assistant-delivery",
      "screen-observation",
      "user-presence",
      "scheduler",
      "speech-input",
    ]);
  });

  it("拒绝未知顶层字段（Schema 字段白名单）", () => {
    const dir = fixture("unknown-field", {
      "manifest.json": JSON.stringify({ ...validManifest, experimental: true }),
      "index.cjs": `module.exports = { register() {} };`,
    });
    expect(readManifest(dir)).toBeNull();
  });

  it("deps 数组去重后仍然合法", () => {
    const dir = fixture("dedup-deps", {
      "manifest.json": JSON.stringify({ ...validManifest, deps: ["llm", "llm"] }),
      "index.cjs": `module.exports = { register() {} };`,
    });
    expect(readManifest(dir)?.deps).toEqual(["llm"]);
  });

  it("拒绝不兼容 apiVersion 和非 SemVer 版本", () => {
    const badApi = fixture("bad-api", {
      "manifest.json": JSON.stringify({ ...validManifest, apiVersion: 2 }),
      "index.cjs": "module.exports = {};",
    });
    const badVersion = fixture("bad-version", {
      "manifest.json": JSON.stringify({ ...validManifest, version: "latest" }),
      "index.cjs": "module.exports = {};",
    });
    expect(readManifest(badApi)).toBeNull();
    expect(readManifest(badVersion)).toBeNull();
  });

  it("icon 字段：合法时保留，非法或缺失时静默忽略", () => {
    const ok = fixture("icon-ok", {
      "manifest.json": JSON.stringify({ ...validManifest, icon: "logo.png" }),
      "index.cjs": "module.exports = {};",
      "logo.png": "fake-png-bytes",
    });
    expect(readManifest(ok)?.icon).toBe("logo.png");

    const missing = fixture("icon-missing", {
      "manifest.json": JSON.stringify({ ...validManifest, icon: "logo.png" }),
      "index.cjs": "module.exports = {};",
    });
    expect(readManifest(missing)?.icon).toBeUndefined();

    const badExt = fixture("icon-bad-ext", {
      "manifest.json": JSON.stringify({ ...validManifest, icon: "logo.exe" }),
      "index.cjs": "module.exports = {};",
      "logo.exe": "x",
    });
    expect(readManifest(badExt)?.icon).toBeUndefined();

    const traversal = fixture("icon-traversal", {
      "manifest.json": JSON.stringify({ ...validManifest, icon: "../logo.png" }),
      "index.cjs": "module.exports = {};",
    });
    const manifest = readManifest(traversal);
    expect(manifest).not.toBeNull();
    expect(manifest?.icon).toBeUndefined();
  });

  it("settingsPanel 字段：合法时保留并带出分区，非法或缺失时静默忽略", () => {
    const ok = fixture("panel-ok", {
      "manifest.json": JSON.stringify({
        ...validManifest,
        settingsPanel: "ui.html",
        settingsSection: "channels",
      }),
      "index.cjs": "module.exports = {};",
      "ui.html": "<!doctype html><html><body>panel</body></html>",
    });
    const okManifest = readManifest(ok);
    expect(okManifest?.settingsPanel).toBe("ui.html");
    expect(okManifest?.settingsSection).toBe("channels");

    // 面板文件缺失：整个面板声明被忽略，分区声明一并丢弃
    const missing = fixture("panel-missing", {
      "manifest.json": JSON.stringify({
        ...validManifest,
        settingsPanel: "ui.html",
        settingsSection: "channels",
      }),
      "index.cjs": "module.exports = {};",
    });
    expect(readManifest(missing)?.settingsPanel).toBeUndefined();
    expect(readManifest(missing)?.settingsSection).toBeUndefined();

    const badExt = fixture("panel-bad-ext", {
      "manifest.json": JSON.stringify({ ...validManifest, settingsPanel: "ui.js" }),
      "index.cjs": "module.exports = {};",
      "ui.js": "x",
    });
    expect(readManifest(badExt)?.settingsPanel).toBeUndefined();

    const traversal = fixture("panel-traversal", {
      "manifest.json": JSON.stringify({ ...validManifest, settingsPanel: "../ui.html" }),
      "index.cjs": "module.exports = {};",
    });
    const traversalManifest = readManifest(traversal);
    expect(traversalManifest).not.toBeNull();
    expect(traversalManifest?.settingsPanel).toBeUndefined();

    const oversize = fixture("panel-oversize", {
      "manifest.json": JSON.stringify({ ...validManifest, settingsPanel: "big.html" }),
      "index.cjs": "module.exports = {};",
      "big.html": "x".repeat(1024 * 1024 + 1),
    });
    expect(readManifest(oversize)?.settingsPanel).toBeUndefined();
  });

  it("settingsSection 枚举外的值：Schema 拒绝整个插件", () => {
    const dir = fixture("panel-bad-section", {
      "manifest.json": JSON.stringify({
        ...validManifest,
        settingsPanel: "ui.html",
        settingsSection: "themes",
      }),
      "index.cjs": "module.exports = {};",
      "ui.html": "<p>panel</p>",
    });
    expect(readManifest(dir)).toBeNull();
  });

  it("settingsSection 缺少面板声明时无意义，被静默丢弃", () => {
    const dir = fixture("panel-section-only", {
      "manifest.json": JSON.stringify({ ...validManifest, settingsSection: "channels" }),
      "index.cjs": "module.exports = {};",
    });
    const manifest = readManifest(dir);
    expect(manifest).not.toBeNull();
    expect(manifest?.settingsSection).toBeUndefined();
  });
});

describe("scanPluginDir", () => {
  it("只收集带合法 manifest 的一级子目录", () => {
    const root = fixture("root", {});
    fixture("root/ok", {
      "manifest.json": JSON.stringify(validManifest),
      "index.cjs": "module.exports = {};",
    });
    fixture("root/bad-json", { "manifest.json": "not json" });
    fixture("root/no-manifest", { "x.txt": "x" });
    expect(scanPluginDir(root).map((r) => r.manifest.id)).toEqual(["demo"]);
  });

  it("根路径不是目录时返回问题而不抛出", () => {
    const file = fixture("not-a-root", { "file.txt": "x" });
    const issues: string[] = [];
    expect(scanPluginDir(path.join(file, "file.txt"), "user", (issue) => issues.push(issue.message))).toEqual([]);
    expect(issues[0]).toMatch(/无法扫描插件目录/);
  });
});

describe("loadPlugin", () => {
  it("加载 CJS 插件并归一化 register", async () => {
    const dir = fixture("cjs", {
      "manifest.json": JSON.stringify(validManifest),
      "index.cjs": `module.exports = { register(ctx) { ctx.log("hi"); } };`,
    });
    const record = scanPluginDir(path.dirname(dir)).find((item) => item.dir === dir)!;
    const plugin = await loadPlugin(record);
    expect(typeof plugin.register).toBe("function");
  });

  it("加载 ESM 插件的默认导出", async () => {
    const dir = fixture("esm-default", {
      "manifest.json": JSON.stringify({ ...validManifest, entry: "index.mjs" }),
      "index.mjs": `export default { register() {} };`,
    });
    const record = scanPluginDir(path.dirname(dir)).find((item) => item.dir === dir)!;
    const plugin = await loadPlugin(record);
    expect(typeof plugin.register).toBe("function");
  });

  it("加载 ESM 插件的命名导出", async () => {
    const dir = fixture("esm-named", {
      "manifest.json": JSON.stringify({ ...validManifest, entry: "index.mjs" }),
      "index.mjs": `export function register() {}`,
    });
    const record = scanPluginDir(path.dirname(dir)).find((item) => item.dir === dir)!;
    const plugin = await loadPlugin(record);
    expect(typeof plugin.register).toBe("function");
  });

  it("入口未导出 register 抛错", async () => {
    const dir = fixture("bad-entry", {
      "manifest.json": JSON.stringify(validManifest),
      "index.cjs": `module.exports = {};`,
    });
    const record = scanPluginDir(path.dirname(dir)).find((item) => item.dir === dir)!;
    await expect(loadPlugin(record)).rejects.toThrow(/register/);
  });
});
