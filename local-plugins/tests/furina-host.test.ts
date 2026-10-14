import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { PluginManager } from "../../src/plugins/manager";
import { ToolRegistry } from "../../src/main/orchestrator/tools/registry/tool-registry";
import { createPluginPromptRegistry } from "../../src/plugins/prompts";

describe.skipIf(!process.env.FURINA_API_PYTHON || !process.env.FURINA_API_SOURCE)("Furina ZIP in real isolated PluginManager", () => {
  it("loads the package, calls the API in three modes, and unregisters on disable", async () => {
    const testRoot = path.resolve(".test-runtime", "furina-host");
    await mkdir(testRoot, { recursive: true });
    const root = await mkdtemp(path.join(testRoot, "run-"));
    const plugins = path.join(root, "plugins");
    const ipc = new Map<string, (...args: unknown[]) => unknown>();
    const registry = new ToolRegistry();
    const manager = new PluginManager({
      scanRoots: [{ path: plugins, source: "user" }],
      storageRoot: path.join(root, "plugin-data"),
      runtime: {
        toolRegistry: registry,
        channelManager: { has: () => false, register: () => {}, unregister: async () => true, startOne: async () => {} },
        registerIpc: (name, handler) => { ipc.set(name, handler); },
        unregisterIpc: (name) => { ipc.delete(name); },
        promptRegistry: createPluginPromptRegistry(),
        llm: { generateText: async () => { throw new Error("Catalog must not call the model"); } },
      },
      loadEnabledMap: () => ({ "furina-file-tools": true }),
      saveEnabledMap: () => {},
    });
    try {
      const archive = unzipSync(new Uint8Array(await readFile("artifacts/furina-file-tools.zip")));
      for (const [name, bytes] of Object.entries(archive)) {
        const target = path.join(plugins, name);
        const relative = path.relative(plugins, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Archive path escapes fixture");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }
      await manager.start();
      expect(manager.overview()).toMatchObject({ issues: [], plugins: [{ id: "furina-file-tools", status: "running" }] });
      expect(manager.overview().plugins[0].canOpen).toBe(true);
      const save = ipc.get("plugin:furina-file-tools:connection-save")!;
      await save({ sourceRoot: process.env.FURINA_API_SOURCE, python: process.env.FURINA_API_PYTHON });
      expect(registry.getEnabledToolsForMode("chat")).toHaveLength(0);
      for (const mode of ["work", "code", "learn"] as const) {
        const tools = registry.getEnabledToolsForMode(mode);
        expect(tools).toHaveLength(4);
        const catalog = tools.find((tool) => tool.id.endsWith("_catalog"))!;
        const result = JSON.parse(await catalog.execute({}, { userQuery: "test", mode }));
        expect(result.service.protocol).toBe(1);
        expect(result.service.backend).toBe("compatibility-python");
      }
      await manager.setEnabled("furina-file-tools", false);
      expect(registry.getAllTools()).toHaveLength(0);
      expect(ipc.has("plugin:furina-file-tools:connection-get")).toBe(false);
      expect(ipc.has("plugin:furina-file-tools:connection-save")).toBe(false);
      expect(manager.overview().plugins[0].status).toBe("disabled");
    } finally {
      await manager.stop();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
