import type { ChannelAdapter } from "../main/channels/adapters/base";
import type { ToolDefinition } from "../main/orchestrator/tool-registry";

/** 插件清单：插件目录下必须存在 manifest.json */
export interface PluginManifest {
  /** 唯一 id，小写连字符，如 "my-plugin" */
  id: string;
  /** 显示名 */
  name: string;
  version: string;
  description: string;
  author: string;
  /** 相对插件目录的入口文件，如 "index.cjs" / "index.mjs" / "index.js" */
  entry: string;
  defaultEnabled: boolean;
  /** 需要注入的主程序内部依赖白名单 */
  deps?: Array<"channels" | "llm">;
}

/** ChannelManager 的结构子集：运行时注入用，插件只允许使用这些方法 */
export interface ChannelManagerLike {
  has(id: string): boolean;
  register(adapter: ChannelAdapter): void;
  unregister(id: string): Promise<boolean>;
  startOne(id: string): Promise<void>;
}

export interface PluginDeps {
  channels?: { channelManager: ChannelManagerLike };
  llm?: LlmDeps;
}

export interface LlmDeps {
  /** 用主聊天模型完成一次非流式文本请求 */
  generateText(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  ): Promise<string>;
}

export interface PluginStorage {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  rootDir(): string;
}

export interface PluginContext {
  /** 插件 id（冗余，便于日志与调试） */
  id: string;
  registerTool(tool: ToolDefinition): void;
  unregisterTool(toolId: string): void;
  /** 自动加 plugin:<id>: 前缀 */
  registerIpc(channel: string, handler: (...args: unknown[]) => unknown): void;
  unregisterIpc(channel: string): void;
  registerChannelAdapter(adapter: ChannelAdapter): Promise<void>;
  unregisterChannelAdapter(channelId: string): Promise<void>;
  storage: PluginStorage;
  deps: PluginDeps;
  log(...args: unknown[]): void;
}

export interface CyrenePlugin {
  /** 可选的用户可见入口，例如打开插件工作台窗口 */
  open?(): void | Promise<void>;
  register(ctx: PluginContext): void | Promise<void>;
  unregister?(): void | Promise<void>;
}

export interface PluginRecord {
  manifest: PluginManifest;
  dir: string;
}
