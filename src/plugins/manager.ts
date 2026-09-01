import path from "node:path";
import { IPC } from "../shared/ipc-channels";
import { createContext, type PluginRuntime } from "./context";
import { loadPlugin, scanPluginDir } from "./loader";
import type { CyrenePlugin, PluginContext, PluginRecord } from "./types";

export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  defaultEnabled: boolean;
  enabled: boolean;
  hasUnregister: boolean;
  canOpen: boolean;
}

export interface PluginManagerOptions {
  /** 插件扫描根目录（内置 + 用户目录） */
  scanRoots: string[];
  /** 插件私有存储根目录（userData/plugin-data） */
  storageRoot: string;
  runtime: PluginRuntime;
  loadEnabledMap: () => Record<string, boolean>;
  saveEnabledMap: (map: Record<string, boolean>) => void;
  /** 列表/开关变化后回调（设置面板刷新用，可空） */
  onListChanged?: () => void;
}

type DisposableContext = PluginContext & { dispose(): Promise<void> };

export class PluginManager {
  private records = new Map<string, PluginRecord>();
  private instances = new Map<string, CyrenePlugin>();
  private contexts = new Map<string, DisposableContext>();
  private enabledMap: Record<string, boolean>;

  constructor(private opts: PluginManagerOptions) {
    this.enabledMap = opts.loadEnabledMap() ?? {};
  }

  list(): PluginListEntry[] {
    return Array.from(this.records.values()).map((r) => {
      const plugin = this.instances.get(r.manifest.id);
      return {
        id: r.manifest.id,
        name: r.manifest.name,
        version: r.manifest.version,
        description: r.manifest.description,
        author: r.manifest.author,
        entry: r.manifest.entry,
        defaultEnabled: r.manifest.defaultEnabled,
        enabled: this.instances.has(r.manifest.id),
        hasUnregister: typeof plugin?.unregister === "function",
        canOpen: typeof plugin?.open === "function",
      };
    });
  }

  async start(): Promise<void> {
    for (const root of this.opts.scanRoots) {
      for (const record of scanPluginDir(root)) {
        if (this.records.has(record.manifest.id)) {
          console.warn(`[plugins] 插件 id 重复，忽略 ${record.dir}`);
          continue;
        }
        this.records.set(record.manifest.id, record);
      }
    }
    for (const [id] of this.records) {
      const enabled = this.enabledMap[id] ?? this.records.get(id)!.manifest.defaultEnabled;
      if (!enabled) continue;
      try {
        await this.activate(id);
      } catch (err) {
        console.error(`[plugins] 插件 ${id} 启用失败，跳过`, err);
      }
    }
    this.opts.runtime.registerIpc(IPC.PLUGINS_LIST, () => this.list());
    this.opts.runtime.registerIpc(IPC.PLUGINS_SET_ENABLED, async (id: unknown, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        return { ok: false, error: "enabled 必须是布尔值" };
      }
      return this.setEnabled(String(id), enabled);
    });
    this.opts.runtime.registerIpc(IPC.PLUGINS_OPEN, (id: unknown) => this.open(String(id)));
    this.opts.onListChanged?.();
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const record = this.records.get(id);
    if (!record) return { ok: false, error: `插件不存在: ${id}` };
    const running = this.instances.has(id);
    if (running === enabled) return { ok: true };
    try {
      if (enabled) await this.activate(id);
      else await this.deactivate(id);
      this.enabledMap[id] = enabled;
      this.opts.saveEnabledMap({ ...this.enabledMap });
      this.opts.onListChanged?.();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async open(id: string): Promise<{ ok: boolean; error?: string }> {
    const plugin = this.instances.get(id);
    if (!plugin) return { ok: false, error: `插件未启用: ${id}` };
    if (!plugin.open) return { ok: false, error: `插件不支持打开窗口: ${id}` };
    try {
      await plugin.open();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async stop(): Promise<void> {
    for (const id of Array.from(this.instances.keys())) {
      try {
        await this.deactivate(id);
      } catch (err) {
        console.warn(`[plugins] 插件 ${id} 停止失败，继续清理其他插件`, err);
      }
    }
    for (const channel of [IPC.PLUGINS_LIST, IPC.PLUGINS_SET_ENABLED, IPC.PLUGINS_OPEN]) {
      try {
        this.opts.runtime.unregisterIpc(channel);
      } catch (err) {
        console.warn(`[plugins] 管理通道 ${channel} 清理失败`, err);
      }
    }
    this.records.clear();
  }

  private async activate(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || this.instances.has(id)) return;
    const plugin = await loadPlugin(record);
    const ctx = createContext(
      id,
      path.join(this.opts.storageRoot, id),
      this.opts.runtime,
      record.manifest.deps,
    );
    try {
      await plugin.register(ctx);
    } catch (err) {
      // register 抛错时立即释放已注册资源，避免泄漏
      await ctx.dispose();
      throw err;
    }
    this.instances.set(id, plugin);
    this.contexts.set(id, ctx);
    console.log(`[plugins] 已启用 ${id}@${record.manifest.version}`);
  }

  private async deactivate(id: string): Promise<void> {
    const plugin = this.instances.get(id);
    try {
      if (plugin?.unregister) {
        try {
          await plugin.unregister();
        } catch (err) {
          console.warn(`[plugins] 插件 ${id} unregister 失败，继续释放框架资源`, err);
        }
      }
    } finally {
      try {
        await this.contexts.get(id)?.dispose();
      } finally {
        this.instances.delete(id);
        this.contexts.delete(id);
      }
    }
    console.log(`[plugins] 已禁用 ${id}`);
  }
}
