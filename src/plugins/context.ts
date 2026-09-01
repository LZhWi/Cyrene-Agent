import type { ChannelAdapter } from "../main/channels/adapters/base";
import type { ToolDefinition } from "../main/orchestrator/tool-registry";
import { createPluginStorage } from "./storage";
import type {
  ChannelManagerLike,
  LlmDeps,
  PluginContext,
  PluginDeps,
  PluginManifest,
} from "./types";

export interface PluginRuntime {
  toolRegistry: {
    register(tool: ToolDefinition): void;
    unregister(id: string): boolean;
    /** 供冲突告警使用；不存在时跳过 */
    getById?(id: string): ToolDefinition | undefined;
  };
  channelManager: ChannelManagerLike;
  registerIpc: (channel: string, handler: (...args: unknown[]) => unknown) => void;
  unregisterIpc: (channel: string) => void;
  llm?: LlmDeps;
}

interface DisposableContext extends PluginContext {
  /** 框架内部：卸载插件时统一清理已注册资源 */
  dispose(): Promise<void>;
}

export function createContext(
  id: string,
  storageRoot: string,
  runtime: PluginRuntime,
  declaredDeps?: PluginManifest["deps"],
): DisposableContext {
  const registeredTools = new Set<string>();
  const registeredIpc = new Set<string>();
  const registeredAdapters = new Set<string>();

  // deps 白名单生效：只有 manifest.deps 声明的依赖才会注入
  const deps: PluginDeps = {};
  if (declaredDeps?.includes("channels")) {
    deps.channels = { channelManager: runtime.channelManager };
  }
  if (declaredDeps?.includes("llm") && runtime.llm) {
    deps.llm = runtime.llm;
  }

  const ctx: PluginContext = {
    id,
    registerTool(tool: ToolDefinition) {
      const expectedPrefix = `${id}_`;
      if (!tool.id.startsWith(expectedPrefix)) {
        throw new Error(`插件工具 id 必须以 "${expectedPrefix}" 开头: ${tool.id}`);
      }
      const existing = runtime.toolRegistry.getById?.(tool.id);
      if (existing) {
        throw new Error(`插件工具 id 已被占用: ${tool.id}`);
      }
      runtime.toolRegistry.register(tool);
      registeredTools.add(tool.id);
    },
    unregisterTool(toolId: string) {
      runtime.toolRegistry.unregister(toolId);
      registeredTools.delete(toolId);
    },
    registerIpc(channel: string, handler: (...args: unknown[]) => unknown) {
      const full = `plugin:${id}:${channel}`;
      runtime.registerIpc(full, handler);
      registeredIpc.add(full);
    },
    unregisterIpc(channel: string) {
      const full = `plugin:${id}:${channel}`;
      runtime.unregisterIpc(full);
      registeredIpc.delete(full);
    },
    async registerChannelAdapter(adapter: ChannelAdapter) {
      if (runtime.channelManager.has(adapter.id)) {
        throw new Error(`插件渠道 id 已被占用: ${adapter.id}`);
      }
      runtime.channelManager.register(adapter);
      try {
        await runtime.channelManager.startOne(adapter.id);
      } catch (err) {
        // 半成功回滚：start 失败时撤销已注册的 adapter，避免 dispose 遗漏
        await runtime.channelManager.unregister(adapter.id);
        throw err;
      }
      registeredAdapters.add(adapter.id);
    },
    async unregisterChannelAdapter(channelId: string) {
      await runtime.channelManager.unregister(channelId);
      registeredAdapters.delete(channelId);
    },
    storage: createPluginStorage(storageRoot),
    deps,
    log(...args: unknown[]) {
      console.log(`[plugin:${id}]`, ...args);
    },
  };

  return Object.assign(ctx, {
    async dispose() {
      const cleanupErrors: unknown[] = [];
      for (const toolId of registeredTools) {
        try {
          runtime.toolRegistry.unregister(toolId);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      registeredTools.clear();
      for (const channel of registeredIpc) {
        try {
          runtime.unregisterIpc(channel);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      registeredIpc.clear();
      const adapterIds = Array.from(registeredAdapters);
      registeredAdapters.clear();
      const adapterResults = await Promise.allSettled(
        adapterIds.map((adapterId) => runtime.channelManager.unregister(adapterId)),
      );
      for (const result of adapterResults) {
        if (result.status === "rejected") cleanupErrors.push(result.reason);
      }
      if (cleanupErrors.length > 0) {
        console.warn(`[plugin:${id}] 清理资源时发生 ${cleanupErrors.length} 个错误`, cleanupErrors);
      }
    },
  });
}
