import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPluginTool,
  assertValidManifest,
  createMockPluginContext,
} from "@playa0v0/cyrene-plugin-sdk/testing";

const require = createRequire(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactsRoot = path.join(workspaceRoot, "artifacts");

function createMockDeps() {
  const task = {
    id: "mock-task",
    title: "mock",
    prompt: "mock",
    mode: "chat",
    schedule: { kind: "daily", timeOfDay: "09:00" },
    allowedToolIds: [],
    enabled: false,
    nextFireAt: null,
    createdAt: "",
    updatedAt: "",
  };
  return {
    channels: { has: () => false },
    llm: { generateText: async () => "模拟回复" },
    secrets: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => false,
    },
    workspace: { getBinding: async () => null },
    conversations: {
      list: async () => ({ items: [] }),
      getMessages: async () => ({ items: [], range: {} }),
    },
    assistantDelivery: {
      postProactiveMessage: async () => ({ conversationId: "mock-proactive", messageId: "mock-message", at: new Date(0).toISOString() }),
    },
    screenObservation: {
      observe: async () => "模拟屏幕摘要",
    },
    userPresence: {
      snapshot: async () => ({ at: new Date(0).toISOString(), idleSeconds: 0, screenLocked: false }),
    },
    scheduler: {
      createTask: async () => ({ ...task }),
      listTasks: async () => [],
      updateTask: async () => ({ ...task }),
      deleteTask: async () => true,
      getHistory: async () => [],
    },
    speechInput: {
      acquire: async () => ({
        commit: async () => undefined,
        release: async () => undefined,
        signal: new AbortController().signal,
      }),
    },
  };
}

const artifactDirs = (await readdir(artifactsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (artifactDirs.length === 0) throw new Error("没有可冒烟验证的构建产物");

for (const id of artifactDirs) {
  const pluginDir = path.join(artifactsRoot, id);
  const manifest = JSON.parse(await readFile(path.join(pluginDir, "manifest.json"), "utf8"));
  const sdkManifest = Array.isArray(manifest.deps)
    ? { ...manifest, deps: manifest.deps.filter((dep) => dep !== "assistant-delivery" && dep !== "screen-observation" && dep !== "user-presence") }
    : manifest;
  assertValidManifest(sdkManifest);

  const plugin = require(path.join(pluginDir, manifest.entry));
  if (typeof plugin?.register !== "function") {
    throw new Error(`${id} 构建入口未直接导出 register()`);
  }

  const allDeps = createMockDeps();
  const ctx = createMockPluginContext({ pluginId: id, deps: Object.fromEntries(
    (manifest.deps ?? []).map((key) => {
      const field = key === "speech-input" ? "speechInput"
        : key === "assistant-delivery" ? "assistantDelivery"
          : key === "screen-observation" ? "screenObservation"
            : key === "user-presence" ? "userPresence" : key;
      return [field, allDeps[field]];
    })
  ) });
  ctx.storage.rootDir = () => pluginDir;
  await plugin.register(ctx);
  for (const tool of ctx.tools) assertPluginTool(tool, id);
  await ctx.dispose();
  await plugin.unregister?.();
  console.log(`[smoke] ${id}: 构建入口可加载，${ctx.tools.length} 个工具契约通过`);
}
