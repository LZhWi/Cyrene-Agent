import path from "node:path";
import { lstat, realpath, rm } from "node:fs/promises";
import { IPC } from "../shared/ipc-channels";
import { createContext, type PluginRuntime } from "./context";
import {
  clearPluginModuleCache,
  loadPlugin,
  scanPluginDir,
  type PluginScanIssue,
} from "./loader";
import type {
  CyrenePlugin,
  PluginContext,
  PluginRecord,
  PluginSource,
} from "./types";

export type PluginRuntimeStatus =
  | "disabled"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export interface PluginListEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  apiVersion: number;
  source: PluginSource;
  path: string;
  defaultEnabled: boolean;
  /** Desired persisted state, distinct from whether activation succeeded. */
  configuredEnabled: boolean;
  /** Backward-compatible running flag. */
  enabled: boolean;
  status: PluginRuntimeStatus;
  error?: string;
  hasUnregister: boolean;
  canOpen: boolean;
}

export interface PluginOverview {
  plugins: PluginListEntry[];
  issues: PluginScanIssue[];
}

export interface PluginScanRoot {
  path: string;
  source: PluginSource;
}

export interface PluginManagerOptions {
  scanRoots: PluginScanRoot[];
  /** Plugin-private data root (userData/plugin-data). */
  storageRoot: string;
  runtime: PluginRuntime;
  loadEnabledMap: () => Record<string, boolean>;
  saveEnabledMap: (map: Record<string, boolean>) => void;
  onListChanged?: () => void;
}

type DisposableContext = PluginContext & { dispose(): Promise<void> };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class PluginManager {
  private records = new Map<string, PluginRecord>();
  private instances = new Map<string, CyrenePlugin>();
  private contexts = new Map<string, DisposableContext>();
  private statuses = new Map<string, PluginRuntimeStatus>();
  private errors = new Map<string, string>();
  private scanIssues: PluginScanIssue[] = [];
  private enabledMap: Record<string, boolean>;
  private started = false;
  /** All lifecycle mutations are serialized to prevent enable/disable/rescan races. */
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private opts: PluginManagerOptions) {
    this.enabledMap = opts.loadEnabledMap() ?? {};
  }

  list(): PluginListEntry[] {
    return Array.from(this.records.values())
      .map((record) => {
        const id = record.manifest.id;
        const plugin = this.instances.get(id);
        const status = this.statuses.get(id) ?? "disabled";
        return {
          id,
          name: record.manifest.name,
          version: record.manifest.version,
          description: record.manifest.description,
          author: record.manifest.author,
          entry: record.manifest.entry,
          apiVersion: record.manifest.apiVersion,
          source: record.source,
          path: record.dir,
          defaultEnabled: record.manifest.defaultEnabled,
          configuredEnabled: this.isConfiguredEnabled(record),
          enabled: status === "running",
          status,
          error: this.errors.get(id),
          hasUnregister: typeof plugin?.unregister === "function",
          canOpen: typeof plugin?.open === "function",
        };
      })
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === "builtin" ? -1 : 1;
        return a.name.localeCompare(b.name, "zh-CN");
      });
  }

  overview(): PluginOverview {
    return { plugins: this.list(), issues: [...this.scanIssues] };
  }

  start(): Promise<void> {
    return this.enqueueOperation(async () => {
      if (this.started) return;
      this.started = true;
      this.opts.runtime.registerIpc(IPC.PLUGINS_LIST, () => this.overview());
      this.opts.runtime.registerIpc(
        IPC.PLUGINS_SET_ENABLED,
        async (id: unknown, enabled: unknown) => {
          if (typeof id !== "string" || !id) {
            return { ok: false, error: "id 必须是非空字符串" };
          }
          if (typeof enabled !== "boolean") {
            return { ok: false, error: "enabled 必须是布尔值" };
          }
          return this.setEnabled(id, enabled);
        },
      );
      this.opts.runtime.registerIpc(IPC.PLUGINS_OPEN, (id: unknown) => {
        if (typeof id !== "string" || !id) {
          return { ok: false, error: "id 必须是非空字符串" };
        }
        return this.open(id);
      });
      this.opts.runtime.registerIpc(IPC.PLUGINS_RESCAN, () => this.rescan());
      this.opts.runtime.registerIpc(IPC.PLUGINS_UNINSTALL, (id: unknown) => {
        if (typeof id !== "string" || !id) {
          return { ok: false, error: "id 必须是非空字符串" };
        }
        return this.uninstall(id);
      });
      await this.doRescan(false);
      this.opts.onListChanged?.();
    });
  }

  rescan(): Promise<PluginOverview> {
    return this.enqueueOperation(async () => {
      await this.doRescan(true);
      this.opts.onListChanged?.();
      return this.overview();
    });
  }

  setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueOperation(async () => {
      const record = this.records.get(id);
      if (!record) return { ok: false, error: `插件不存在: ${id}` };

      this.enabledMap[id] = enabled;
      try {
        this.opts.saveEnabledMap({ ...this.enabledMap });
      } catch (error) {
        return { ok: false, error: `保存插件开关失败: ${errorMessage(error)}` };
      }

      if (!enabled) {
        await this.deactivate(id);
        this.statuses.set(id, "disabled");
        this.errors.delete(id);
        this.opts.onListChanged?.();
        return { ok: true };
      }

      if (this.instances.has(id)) {
        this.statuses.set(id, "running");
        this.errors.delete(id);
        return { ok: true };
      }
      try {
        await this.activate(id);
        this.opts.onListChanged?.();
        return { ok: true };
      } catch (error) {
        const message = errorMessage(error);
        this.statuses.set(id, "failed");
        this.errors.set(id, message);
        this.opts.onListChanged?.();
        return { ok: false, error: message };
      }
    });
  }

  open(id: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueOperation(async () => {
      const plugin = this.instances.get(id);
      if (!plugin) return { ok: false, error: `插件未运行: ${id}` };
      if (!plugin.open) return { ok: false, error: `插件不支持打开窗口: ${id}` };
      try {
        await plugin.open();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  uninstall(id: string): Promise<{ ok: boolean; error?: string; overview?: PluginOverview }> {
    return this.enqueueOperation(async () => {
      const record = this.records.get(id);
      if (!record) return { ok: false, error: `插件不存在: ${id}` };
      if (record.source !== "user") {
        return { ok: false, error: `内置插件不能卸载: ${id}` };
      }

      try {
        await this.assertSafeUserPluginDirectory(record);
      } catch (error) {
        return { ok: false, error: `拒绝卸载不安全的插件路径: ${errorMessage(error)}` };
      }

      await this.deactivate(id);

      // 先持久化“未启用”语义。即使随后目录删除失败，下一次扫描也不会自动重启插件。
      const nextEnabledMap = { ...this.enabledMap };
      delete nextEnabledMap[id];
      try {
        this.opts.saveEnabledMap(nextEnabledMap);
        this.enabledMap = nextEnabledMap;
      } catch (error) {
        const message = `清理插件启停记录失败，未删除目录: ${errorMessage(error)}`;
        this.statuses.set(id, "failed");
        this.errors.set(id, message);
        this.opts.onListChanged?.();
        return { ok: false, error: message };
      }

      try {
        // unregister() 属于第三方代码，执行后再次校验，避免它在清理阶段替换目标目录。
        await this.assertSafeUserPluginDirectory(record);
        clearPluginModuleCache(record.dir);
        await rm(record.dir, { recursive: true, force: false });
      } catch (error) {
        const message = `删除插件目录失败: ${errorMessage(error)}`;
        this.statuses.set(id, "disabled");
        this.errors.set(id, message);
        this.opts.onListChanged?.();
        return { ok: false, error: message };
      }

      await this.doRescan(false);
      this.opts.onListChanged?.();
      return { ok: true, overview: this.overview() };
    });
  }

  stop(): Promise<void> {
    return this.enqueueOperation(async () => {
      if (!this.started) return;
      for (const id of Array.from(this.instances.keys())) {
        await this.deactivate(id);
      }
      for (const channel of [
        IPC.PLUGINS_LIST,
        IPC.PLUGINS_SET_ENABLED,
        IPC.PLUGINS_OPEN,
        IPC.PLUGINS_RESCAN,
        IPC.PLUGINS_UNINSTALL,
      ]) {
        try {
          this.opts.runtime.unregisterIpc(channel);
        } catch (error) {
          console.warn(`[plugins] 管理通道 ${channel} 清理失败`, error);
        }
      }
      this.records.clear();
      this.statuses.clear();
      this.errors.clear();
      this.scanIssues = [];
      this.started = false;
    });
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private isConfiguredEnabled(record: PluginRecord): boolean {
    if (Object.prototype.hasOwnProperty.call(this.enabledMap, record.manifest.id)) {
      return this.enabledMap[record.manifest.id] === true;
    }
    // User-installed code is never executed on first discovery without opt-in.
    return record.source === "builtin" && record.manifest.defaultEnabled;
  }

  private async assertSafeUserPluginDirectory(record: PluginRecord): Promise<void> {
    const candidateRoot = this.opts.scanRoots.find((root) => {
      if (root.source !== "user") return false;
      const relative = path.relative(path.resolve(root.path), path.resolve(record.dir));
      return relative.length > 0
        && !relative.startsWith("..")
        && !path.isAbsolute(relative)
        && !relative.includes(path.sep);
    });
    if (!candidateRoot) throw new Error("插件目录不是用户插件根目录的一级子目录");

    const stat = await lstat(record.dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("插件路径不是普通目录");
    }

    const [rootReal, pluginReal] = await Promise.all([
      realpath(candidateRoot.path),
      realpath(record.dir),
    ]);
    const relative = path.relative(rootReal, pluginReal);
    if (
      relative.length === 0
      || relative.startsWith("..")
      || path.isAbsolute(relative)
      || relative.includes(path.sep)
    ) {
      throw new Error("插件真实路径不在用户插件根目录的一级范围内");
    }
  }

  private scanAll(): {
    records: Map<string, PluginRecord>;
    issues: PluginScanIssue[];
    failedRoots: Set<string>;
  } {
    const records = new Map<string, PluginRecord>();
    const issues: PluginScanIssue[] = [];
    const failedRoots = new Set<string>();
    for (const root of this.opts.scanRoots) {
      const onIssue = (issue: PluginScanIssue): void => {
        issues.push(issue);
        if (!issue.path) failedRoots.add(root.path);
      };
      for (const record of scanPluginDir(root.path, root.source, onIssue)) {
        const existing = records.get(record.manifest.id);
        if (existing) {
          const issue: PluginScanIssue = {
            root: root.path,
            path: record.dir,
            source: root.source,
            message: `插件 id 重复，已保留 ${existing.dir}`,
          };
          issues.push(issue);
          console.warn(`[plugins] ${issue.message}，忽略 ${record.dir}`);
          continue;
        }
        records.set(record.manifest.id, record);
      }
    }
    return { records, issues, failedRoots };
  }

  private async doRescan(reloadActive: boolean): Promise<void> {
    const scanned = this.scanAll();
    const previousRecords = this.records;
    // A transient root-level read error must not unload already-running plugins.
    for (const previous of previousRecords.values()) {
      const failedRoot = this.opts.scanRoots.find(
        (root) => scanned.failedRoots.has(root.path) && previous.source === root.source,
      );
      if (failedRoot && !scanned.records.has(previous.manifest.id)) {
        scanned.records.set(previous.manifest.id, previous);
      }
    }
    const activeBefore = new Set(this.instances.keys());

    for (const id of activeBefore) {
      const before = previousRecords.get(id);
      const after = scanned.records.get(id);
      const changed = !before
        || !after
        || before.dir !== after.dir
        || before.fingerprint !== after.fingerprint;
      if (reloadActive || changed) await this.deactivate(id);
    }

    this.records = scanned.records;
    this.scanIssues = scanned.issues;

    for (const id of Array.from(this.statuses.keys())) {
      if (!this.records.has(id)) {
        this.statuses.delete(id);
        this.errors.delete(id);
      }
    }

    for (const [id, record] of this.records) {
      if (this.instances.has(id)) {
        this.statuses.set(id, "running");
        continue;
      }
      if (!this.isConfiguredEnabled(record)) {
        this.statuses.set(id, "disabled");
        this.errors.delete(id);
        continue;
      }
      try {
        await this.activate(id);
      } catch (error) {
        const message = errorMessage(error);
        this.statuses.set(id, "failed");
        this.errors.set(id, message);
        console.error(`[plugins] 插件 ${id} 启用失败，跳过`, error);
      }
    }
  }

  private async activate(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record || this.instances.has(id)) return;
    this.statuses.set(id, "starting");
    this.errors.delete(id);
    try {
      const plugin = await loadPlugin(record);
      const ctx = createContext(
        id,
        path.join(this.opts.storageRoot, id),
        this.opts.runtime,
        record.manifest.deps,
      );
      try {
        await plugin.register(ctx);
      } catch (error) {
        if (plugin.unregister) {
          try {
            await plugin.unregister();
          } catch (cleanupError) {
            console.warn(`[plugins] 插件 ${id} 激活回滚时 unregister 失败`, cleanupError);
          }
        }
        await ctx.dispose();
        throw error;
      }
      this.instances.set(id, plugin);
      this.contexts.set(id, ctx);
      this.statuses.set(id, "running");
      console.log(`[plugins] 已启用 ${id}@${record.manifest.version}`);
    } catch (error) {
      const message = errorMessage(error);
      this.statuses.set(id, "failed");
      this.errors.set(id, message);
      throw error;
    }
  }

  private async deactivate(id: string): Promise<void> {
    const plugin = this.instances.get(id);
    const context = this.contexts.get(id);
    if (!plugin && !context) return;
    this.statuses.set(id, "stopping");
    try {
      if (plugin?.unregister) {
        try {
          await plugin.unregister();
        } catch (error) {
          console.warn(`[plugins] 插件 ${id} unregister 失败，继续释放框架资源`, error);
        }
      }
    } finally {
      try {
        await context?.dispose();
      } finally {
        this.instances.delete(id);
        this.contexts.delete(id);
      }
    }
    this.statuses.set(id, "disabled");
    console.log(`[plugins] 已禁用 ${id}`);
  }
}
