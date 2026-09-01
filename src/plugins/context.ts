import type { ChannelAdapter } from "../main/channels/adapters/base";
import type { ToolDefinition } from "../main/orchestrator/tools/registry/tool-registry";
import { createPluginStorage } from "./storage";
import type {
  PluginChannelAdapter,
  PluginContext,
  PluginDeps,
  PluginLlmService,
  PluginManifest,
  PluginTool,
} from "./types";

const IPC_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface PluginRuntime {
  toolRegistry: {
    register(tool: ToolDefinition): void;
    unregister(id: string): boolean;
    /** 供冲突告警使用；不存在时跳过 */
    getById?(id: string): ToolDefinition | undefined;
  };
  channelManager: {
    has(id: string): boolean;
    register(adapter: ChannelAdapter): void;
    unregister(id: string): Promise<boolean>;
    startOne(id: string): Promise<void>;
  };
  registerIpc: (channel: string, handler: (...args: unknown[]) => unknown) => void;
  unregisterIpc: (channel: string) => void;
  llm?: PluginLlmService;
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
    deps.channels = { has: (channelId) => runtime.channelManager.has(channelId) };
  }
  if (declaredDeps?.includes("llm") && runtime.llm) {
    deps.llm = {
      generateText: (messages, options) => runtime.llm!.generateText(messages, {
        ...options,
        purpose: options?.purpose ? `${id}:${options.purpose}` : id,
      }),
    };
  }

  const ctx: PluginContext = {
    id,
    registerTool(tool: PluginTool) {
      const expectedPrefix = `${id}_`;
      if (!tool.id.startsWith(expectedPrefix)) {
        throw new Error(`插件工具 id 必须以 "${expectedPrefix}" 开头: ${tool.id}`);
      }
      if (registeredTools.has(tool.id)) {
        throw new Error(`插件工具 id 已由当前插件注册: ${tool.id}`);
      }
      const existing = runtime.toolRegistry.getById?.(tool.id);
      if (existing) {
        throw new Error(`插件工具 id 已被占用: ${tool.id}`);
      }
      runtime.toolRegistry.register(tool as ToolDefinition);
      registeredTools.add(tool.id);
    },
    unregisterTool(toolId: string) {
      if (!registeredTools.has(toolId)) {
        throw new Error(`不能注销不属于当前插件的工具: ${toolId}`);
      }
      runtime.toolRegistry.unregister(toolId);
      registeredTools.delete(toolId);
    },
    registerIpc(channel: string, handler: (...args: unknown[]) => unknown) {
      if (!IPC_SEGMENT_RE.test(channel)) {
        throw new Error(`非法插件 IPC channel: ${channel}`);
      }
      const full = `plugin:${id}:${channel}`;
      if (registeredIpc.has(full)) {
        throw new Error(`插件 IPC channel 已注册: ${channel}`);
      }
      runtime.registerIpc(full, handler);
      registeredIpc.add(full);
    },
    unregisterIpc(channel: string) {
      const full = `plugin:${id}:${channel}`;
      if (!registeredIpc.has(full)) {
        throw new Error(`不能注销不属于当前插件的 IPC channel: ${channel}`);
      }
      runtime.unregisterIpc(full);
      registeredIpc.delete(full);
    },
    async registerChannelAdapter(adapter: PluginChannelAdapter) {
      if (registeredAdapters.has(adapter.id)) {
        throw new Error(`插件渠道 id 已由当前插件注册: ${adapter.id}`);
      }
      if (runtime.channelManager.has(adapter.id)) {
        throw new Error(`插件渠道 id 已被占用: ${adapter.id}`);
      }
      runtime.channelManager.register(adapter as unknown as ChannelAdapter);
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
      if (!registeredAdapters.has(channelId)) {
        throw new Error(`不能注销不属于当前插件的渠道: ${channelId}`);
      }
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
