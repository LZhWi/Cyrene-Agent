import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_PLUGIN_API_VERSION,
  validateManifestData,
} from "@playa0v0/cyrene-plugin-sdk";
import {
  assertPluginTool,
  createMockPluginContext,
} from "@playa0v0/cyrene-plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./src/index";

const pluginDir = path.resolve("plugins", "plugin-template");

describe("plugin-template", () => {
  it("manifest 与当前 Plugin API 兼容", async () => {
    const manifest = JSON.parse(await readFile(path.join(pluginDir, "manifest.json"), "utf8"));
    const result = validateManifestData(manifest);

    expect(result.ok, result.error).toBe(true);
    expect(result.value?.apiVersion).toBe(CURRENT_PLUGIN_API_VERSION);
    expect(result.value?.id).toBe("plugin-template");
  });

  it("能够注册工具并完成幂等清理", async () => {
    const ctx = createMockPluginContext({ pluginId: "plugin-template" });

    await plugin.register(ctx);
    expect(ctx.tools).toHaveLength(1);
    assertPluginTool(ctx.tools[0], "plugin-template");
    await expect(ctx.tools[0].execute({})).resolves.toBe("插件模板运行正常");

    await ctx.dispose();
    await expect(ctx.tools[0].execute({})).resolves.toBe("插件模板尚未启动");
    await expect(Promise.resolve(plugin.unregister?.())).resolves.toBeUndefined();
    await expect(Promise.resolve(plugin.unregister?.())).resolves.toBeUndefined();
  });
});
