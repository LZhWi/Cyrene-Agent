import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginManager, type PluginManagerOptions } from "./manager";
import type { PluginRuntime } from "./context";

let tmp: string;

function fixturePlugin(id: string, manifestId: string = id): string {
  if (!tmp) tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-mgr-test-"));
  const dir = path.join(tmp, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id: manifestId,
      name: id,
      version: "1.0.0",
      description: "d",
      author: "a",
      entry: "index.cjs",
      defaultEnabled: true,
    }),
    "utf8",
  );
  writeFileSync(
    path.join(dir, "index.cjs"),
    `module.exports = { open() {}, register(ctx) {
      ctx.registerIpc("ping", () => "pong");
      ctx.registerTool({ id: "${id}_tool", name: "t", description: "d", enabled: true, inputSchema: { type: "object", properties: {}, required: [] }, execute: async () => "ok" });
    }, unregister() {} };`,
    "utf8",
  );
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function harness(overrides: Partial<PluginManagerOptions> = {}) {
  const tools: string[] = [];
  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const runtime: PluginRuntime = {
    toolRegistry: {
      register: (t) => tools.push(t.id),
      unregister: (id) => {
        const i = tools.indexOf(id);
        if (i >= 0) tools.splice(i, 1);
        return true;
      },
    },
    channelManager: { has: () => false, register: () => {}, unregister: async () => true, startOne: async () => {} },
    registerIpc: (c, h) => ipc.set(c, h),
    unregisterIpc: (c) => ipc.delete(c),
  };
  let enabledMap: Record<string, boolean> = {};
  const options: PluginManagerOptions = {
    scanRoots: [path.dirname(fixturePlugin("demo"))],
    storageRoot: path.join(tmp ?? "tmp", "storage"),
    runtime,
    loadEnabledMap: () => ({ ...enabledMap }),
    saveEnabledMap: (m) => {
      enabledMap = { ...m };
    },
    ...overrides,
  };
  return { options, tools, ipc, getEnabledMap: () => ({ ...enabledMap }) };
}

describe("PluginManager", () => {
  it("启动时启用 defaultEnabled 插件并注册列表/开关 IPC", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.list().map((e) => e.id)).toEqual(["demo"]);
    expect(mgr.list()[0].enabled).toBe(true);
    expect(h.ipc.has("plugins:list")).toBe(true);
    expect(h.ipc.has("plugins:set-enabled")).toBe(true);
    expect(h.ipc.has("plugin:demo:ping")).toBe(true);
  });

  it("只允许打开已启用且声明 open 的插件", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();

    expect(mgr.list()[0].canOpen).toBe(true);
    expect(h.ipc.has("plugins:open")).toBe(true);
    await expect(h.ipc.get("plugins:open")?.("demo")).resolves.toEqual({ ok: true });

    await mgr.setEnabled("demo", false);
    await expect(h.ipc.get("plugins:open")?.("demo")).resolves.toMatchObject({ ok: false });
  });

  it("开关关闭的插件不激活", async () => {
    const h = harness({
      loadEnabledMap: () => ({ demo: false }),
    });
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.list()[0].enabled).toBe(false);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
  });

  it("setEnabled(false) 清理资源并持久化；setEnabled(true) 重新激活", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(h.tools).toContain("demo_tool");

    const off = await mgr.setEnabled("demo", false);
    expect(off.ok).toBe(true);
    expect(mgr.list()[0].enabled).toBe(false);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
    expect(h.tools).toEqual([]);
    expect(h.getEnabledMap().demo).toBe(false);

    const on = await mgr.setEnabled("demo", true);
    expect(on.ok).toBe(true);
    expect(h.ipc.has("plugin:demo:ping")).toBe(true);
    expect(h.tools).toContain("demo_tool");
  });

  it("重复 id 只保留第一个扫描结果", async () => {
    const h = harness();
    fixturePlugin("demo-copy", "demo");
    h.options.scanRoots = [path.dirname(fixturePlugin("demo"))];
    const mgr = new PluginManager(h.options);
    await mgr.start();
    expect(mgr.list()).toHaveLength(1);
  });

  it("setEnabled 未知 id 返回失败", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();
    const res = await mgr.setEnabled("nope", true);
    expect(res.ok).toBe(false);
  });

  it("stop 清理插件资源和管理 IPC", async () => {
    const h = harness();
    const mgr = new PluginManager(h.options);
    await mgr.start();

    await mgr.stop();

    expect(mgr.list()).toEqual([]);
    expect(h.tools).toEqual([]);
    expect(h.ipc.size).toBe(0);
  });

  it("unregister 抛错时仍完成停用并持久化状态", async () => {
    const h = harness();
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `module.exports = { register(ctx) { ctx.registerIpc("ping", () => "pong"); }, unregister() { throw new Error("cleanup failed"); } };`,
      "utf8",
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const mgr = new PluginManager(h.options);
    await mgr.start();

    const result = await mgr.setEnabled("demo", false);

    expect(result).toEqual({ ok: true });
    expect(mgr.list()[0].enabled).toBe(false);
    expect(h.ipc.has("plugin:demo:ping")).toBe(false);
    expect(h.getEnabledMap().demo).toBe(false);
  });

  it("启动失败后显示停用；再次启用会重试", async () => {
    const h = harness();
    writeFileSync(
      path.join(tmp, "demo", "index.cjs"),
      `let attempts = 0;
      module.exports = { register(ctx) {
        attempts += 1;
        if (attempts === 1) throw new Error("first start failed");
        ctx.registerIpc("ping", () => "pong");
      } };`,
      "utf8",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mgr = new PluginManager(h.options);

    await mgr.start();
    expect(mgr.list()[0].enabled).toBe(false);

    const retried = await mgr.setEnabled("demo", true);
    expect(retried.ok).toBe(true);
    expect(mgr.list()[0].enabled).toBe(true);
    expect(h.ipc.has("plugin:demo:ping")).toBe(true);
  });
});
