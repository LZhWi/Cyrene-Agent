import { app, ipcMain } from "electron";
import path from "node:path";
import { channelManager } from "./channels/manager";
import type { ChannelId } from "./channels/types";
import { toolRegistry } from "./orchestrator/tool-registry";
import { loadGeneralSettings, saveGeneralSettings } from "./settings/settings-facade";
import { loadModelSettings } from "./settings/model-settings";
import { pluginGenerateText } from "./plugin-llm";
import { PluginManager } from "../plugins/manager";

export async function startPluginRuntime(): Promise<PluginManager> {
  const userPluginRoot = path.join(app.getPath("userData"), "plugins");
  const pluginDataRoot = path.join(app.getPath("userData"), "plugin-data");
  const manager = new PluginManager({
    scanRoots: [path.join(__dirname, "..", "plugins"), userPluginRoot],
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
        ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args));
      },
      unregisterIpc: (channel) => ipcMain.removeHandler(channel),
      llm: {
        generateText: (messages) => pluginGenerateText(messages, loadModelSettings()),
      },
    },
    loadEnabledMap: () => loadGeneralSettings().plugins,
    saveEnabledMap: (plugins) => saveGeneralSettings({ plugins }),
  });
  await manager.start();
  return manager;
}
