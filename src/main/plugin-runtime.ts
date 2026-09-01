import { app, dialog } from "electron";
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
    selectPluginZip: async () => {
      const result = await dialog.showOpenDialog({
        title: "导入 Cyrene 插件",
        properties: ["openFile"],
        filters: [{ name: "Cyrene 插件包", extensions: ["zip"] }],
      });
      return result.canceled ? undefined : result.filePaths[0];
    },
    confirmPluginReplace: async (plugin) => {
      const result = await dialog.showMessageBox({
        type: "warning",
        title: "替换已有插件",
        message: `用户插件 ${plugin.name}（${plugin.id}）已经存在。`,
        detail: `是否用 ZIP 中的 ${plugin.version} 版本替换现有程序？插件私有数据将保留。`,
        buttons: ["取消", "替换"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
  });
  await manager.start();
  return manager;
}
