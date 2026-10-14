import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { assertPluginTool, createMockPluginContext } from "@playa0v0/cyrene-plugin-sdk/testing";
import { validateManifestData } from "@playa0v0/cyrene-plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlugin, requireMode } from "./src/index";
import { LocalApi } from "./src/client";
import { ToolRegistry } from "../../../src/main/orchestrator/tools/registry/tool-registry";

afterEach(() => { vi.restoreAllMocks(); });

describe("furina-file-tools mode boundary", () => {
  it("has a valid installable manifest and tool contracts", async () => {
    const manifest = JSON.parse(await readFile("plugins/furina-file-tools/manifest.json", "utf8"));
    expect(validateManifestData(manifest).ok).toBe(true);
    const ctx = createMockPluginContext({ pluginId: "furina-file-tools" });
    await createPlugin().register(ctx);
    expect(ctx.tools).toHaveLength(4);
    for (const tool of ctx.tools) {
      assertPluginTool(tool, "furina-file-tools");
      expect(tool.modes).toEqual(["work", "code", "learn"]);
    }
    const registry = new ToolRegistry();
    ctx.tools.forEach((tool) => registry.register(tool));
    expect(registry.getEnabledToolsForMode("chat")).toHaveLength(0);
    for (const mode of ["work", "code", "learn"] as const) expect(registry.getEnabledToolsForMode(mode)).toHaveLength(4);
    await ctx.dispose();
  });

  it("rejects chat and missing mode before starting any service, including overridden tools", async () => {
    const requests = vi.spyOn(LocalApi.prototype, "request");
    const ctx = createMockPluginContext({ pluginId: "furina-file-tools" });
    await createPlugin().register(ctx);
    const registry = new ToolRegistry();
    ctx.tools.forEach((tool) => registry.register(tool));
    expect(registry.getEnabledToolsForMode("chat", Object.fromEntries(ctx.tools.map((tool) => [tool.id, { chat: true }])))).toHaveLength(4);
    for (const tool of ctx.tools) {
      await expect(tool.execute({}, { userQuery: "", mode: "chat" })).rejects.toThrow("work/code/learn");
      await expect(tool.execute({})).rejects.toThrow("work/code/learn");
    }
    expect(requests).not.toHaveBeenCalled();
    expect(() => requireMode({ userQuery: "", mode: "work" })).not.toThrow();
    await ctx.dispose();
  });

  it("requires a workspace for processing and gives a concrete configuration error", async () => {
    const ctx = createMockPluginContext({ pluginId: "furina-file-tools" });
    await createPlugin().register(ctx);
    const submit = ctx.tools.find((tool) => tool.id.endsWith("_submit"))!;
    await expect(submit.execute({}, { userQuery: "", mode: "learn" })).rejects.toThrow("工作区");
    const catalog = ctx.tools.find((tool) => tool.id.endsWith("_catalog"))!;
    await expect(catalog.execute({}, { userQuery: "", mode: "code" })).rejects.toThrow("插件设置");
    await ctx.dispose();
  });
});

const python = process.env.FURINA_API_PYTHON;
const sourceRoot = process.env.FURINA_API_SOURCE;
describe.skipIf(!python || !sourceRoot)("furina-file-tools real local API", () => {
  it("processes actual files through plugin tools and stops its owned service", async () => {
    const testRoot = path.resolve(".test-runtime", "furina-file-tools");
    await mkdir(testRoot, { recursive: true });
    const root = await mkdtemp(path.join(testRoot, "run-"));
    const ctx = createMockPluginContext({ pluginId: "furina-file-tools" });
    ctx.storage.rootDir = () => path.join(root, "plugin-data");
    const plugin = createPlugin();
    let ownedApi: LocalApi | undefined;
    const close = LocalApi.prototype.close;
    const closed = vi.spyOn(LocalApi.prototype, "close").mockImplementation(async function (this: LocalApi) {
      ownedApi = this;
      await close.call(this);
    });
    try {
      const fixture = spawnSync(python!, ["-c", [
        "import sys; from pathlib import Path",
        "sys.path.insert(0, str(Path(sys.argv[1])/'.cyrene-runtime'/'python-packages'))",
        "from PIL import Image; import pymupdf",
        "root=Path(sys.argv[2]); Image.new('RGBA',(120,80),(255,0,0,0)).save(root/'测试图片.png')",
        "doc=pymupdf.open(); doc.new_page().insert_text((20,30),'Page A'); doc.save(root/'a.pdf'); doc.close()",
        "doc=pymupdf.open(); doc.new_page().insert_text((20,30),'Page B'); doc.save(root/'b.pdf'); doc.close()",
      ].join("\n"), sourceRoot!, root], { encoding: "utf8", windowsHide: true });
      expect(fixture.status, fixture.stderr).toBe(0);
      ctx.storage.set("connection", { sourceRoot, python });
      await plugin.register(ctx);
      const context = { userQuery: "test", mode: "work" as const, resolvedWorkspaceRoot: root };
      const catalog = JSON.parse(await ctx.tools[0].execute({}, context));
      expect(Object.keys(catalog.catalog.tools)).toHaveLength(7);
      const submit = ctx.tools.find((tool) => tool.id.endsWith("_submit"))!;
      const status = ctx.tools.find((tool) => tool.id.endsWith("_status"))!;
      const initial = JSON.parse(await submit.execute({ tool: "image-convert", inputs: ["测试图片.png"], parameters: { format: "jpg" } }, context));
      let result = initial;
      for (let attempt = 0; attempt < 100 && !["completed", "failed"].includes(result.status); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        result = JSON.parse(await status.execute({ id: initial.id }, context));
      }
      expect(result.status, result.error).toBe("completed");
      expect(result.artifacts[0].path).toContain(".furinakit-output");
      expect((await readFile(result.artifacts[0].path)).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      await expect(submit.execute({ tool: "image-convert", inputs: [path.resolve(root, "..", "outside.png")], parameters: { format: "jpg" } }, context)).rejects.toThrow();
      await ctx.dispose();
      expect(closed).toHaveBeenCalledOnce();
      await expect(ownedApi!.request("/health")).rejects.toThrow("已停止");
    } finally {
      await ctx.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
