import { app } from "electron";
import path from "node:path";
import { channelManager } from "./channels/manager";
import type { ChannelId } from "./channels/types";
import { toolRegistry } from "./orchestrator/tools/registry/tool-registry";
import { loadGeneralSettings, saveGeneralSettings } from "./settings/settings-facade";
import { loadModelSettings, resolveModelSettingsProfile } from "./settings/model-settings";
import { pluginGenerateText } from "./plugin-llm";
import { PluginManager } from "../plugins/manager";
import type { LlmClient } from "./services/llm/llm-client";
import { enqueueLLMTask } from "./llm-queue";
import type { IpcScope } from "./application/ipc-scope";

export interface PluginRuntimeDeps {
  llmClient: LlmClient;
  ipc: IpcScope;
}

export async function startPluginRuntime(deps: PluginRuntimeDeps): Promise<PluginManager> {
  const userPluginRoot = path.join(app.getPath("userData"), "plugins");
  const pluginDataRoot = path.join(app.getPath("userData"), "plugin-data");
  const manager = new PluginManager({
    scanRoots: [
      { path: path.join(__dirname, "..", "plugins"), source: "builtin" },
      { path: userPluginRoot, source: "user" },
    ],
    storageRoot: pluginDataRoot,
    runtime: {
      toolRegistry,
      channelManager: {
        has: (id) => channelManager.has(id as ChannelId),
        register: (adapter) => channelManager.register(adapter),
        unregister: (id) => channelManager.unregister(id as ChannelId),
        startOne: (id) => channelManager.startOne(id as ChannelId),
      },
      registerIpc: (channel, handler) => {
        deps.ipc.handle(channel, (_event, ...args: unknown[]) => handler(...args));
      },
      unregisterIpc: (channel) => deps.ipc.removeHandler(channel),
      llm: {
        generateText: (messages, options) => pluginGenerateText(
          messages,
          resolveModelSettingsProfile(loadModelSettings()),
          deps.llmClient,
          enqueueLLMTask,
          options,
        ),
      },
    },
    loadEnabledMap: () => loadGeneralSettings().plugins,
    saveEnabledMap: (plugins) => saveGeneralSettings({ plugins }),
  });
  await manager.start();
  return manager;
}
