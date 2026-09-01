import { featurePluginsList, featurePluginsRescan } from "./dom";

export type FeaturePluginRuntimeStatus =
  | "disabled"
  | "starting"
  | "running"
  | "stopping"
  | "failed";

export interface FeaturePluginListEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  entry: string;
  apiVersion: number;
  source: "builtin" | "user";
  path: string;
  defaultEnabled: boolean;
  configuredEnabled: boolean;
  enabled: boolean;
  status: FeaturePluginRuntimeStatus;
  error?: string;
  hasUnregister: boolean;
  canOpen: boolean;
}

export interface FeaturePluginScanIssue {
  root: string;
  path?: string;
  source: "builtin" | "user";
  message: string;
}

export interface FeaturePluginOverview {
  plugins: FeaturePluginListEntry[];
  issues: FeaturePluginScanIssue[];
}

export interface FeaturePluginsApi {
  list(): Promise<FeaturePluginOverview | FeaturePluginListEntry[]>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  open(id: string): Promise<{ ok: boolean; error?: string }>;
  rescan(): Promise<FeaturePluginOverview>;
  uninstall(id: string): Promise<{ ok: boolean; error?: string; overview?: FeaturePluginOverview }>;
}

declare global {
  interface Window {
    plugins?: FeaturePluginsApi;
  }
}

function appendTransientError(row: HTMLElement, message: string): void {
  const error = document.createElement("span");
  error.textContent = message;
  error.style.color = "#e5484d";
  error.style.fontSize = "12px";
  row.appendChild(error);
  setTimeout(() => error.remove(), 6000);
}

function normalizeOverview(
  value: FeaturePluginOverview | FeaturePluginListEntry[],
): FeaturePluginOverview {
  return Array.isArray(value) ? { plugins: value, issues: [] } : value;
}

function statusText(item: FeaturePluginListEntry): string {
  switch (item.status) {
    case "running": return "运行中";
    case "starting": return "启动中";
    case "stopping": return "停止中";
    case "failed": return "启动失败";
    default: return "已停用";
  }
}

function renderIssues(list: HTMLElement, issues: FeaturePluginScanIssue[]): void {
  if (issues.length === 0) return;
  const box = document.createElement("div");
  box.className = "settings-empty";
  const heading = document.createElement("strong");
  heading.textContent = `发现 ${issues.length} 个插件扫描问题`;
  box.appendChild(heading);
  for (const issue of issues) {
    const line = document.createElement("div");
    line.textContent = `${issue.path ?? issue.root}：${issue.message}`;
    line.style.color = "#e5484d";
    line.style.fontSize = "12px";
    box.appendChild(line);
  }
  list.appendChild(box);
}

function bindRescan(
  api: FeaturePluginsApi,
  list: HTMLElement,
  button: HTMLButtonElement | null,
): void {
  if (!button || button.dataset.bound === "true") return;
  button.dataset.bound = "true";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "刷新中…";
    try {
      await api.rescan();
      await renderFeaturePlugins(api, list, button);
    } catch (error) {
      appendTransientError(list, `刷新失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      button.disabled = false;
      button.textContent = "刷新插件";
    }
  });
}

export async function renderFeaturePlugins(
  api: FeaturePluginsApi | undefined = window.plugins,
  list: HTMLElement | null = featurePluginsList,
  rescanButton: HTMLButtonElement | null = featurePluginsRescan,
): Promise<void> {
  if (!list || !api) return;
  bindRescan(api, list, rescanButton);
  let overview: FeaturePluginOverview;
  try {
    overview = normalizeOverview(await api.list());
  } catch (error) {
    list.replaceChildren();
    const failure = document.createElement("div");
    failure.className = "settings-empty";
    failure.textContent = `插件列表加载失败：${error instanceof Error ? error.message : String(error)}`;
    list.appendChild(failure);
    return;
  }
  list.replaceChildren();
  renderIssues(list, overview.issues);
  if (overview.plugins.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-empty";
    empty.textContent = "暂无插件：把插件目录放进 userData/plugins/ 后点击“刷新插件”";
    list.appendChild(empty);
    return;
  }

  for (const item of overview.plugins) {
    const row = document.createElement("div");
    row.className = "setting-row";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = `${item.name} v${item.version} · ${statusText(item)}`;
    const description = document.createElement("span");
    description.textContent = `${item.description}（${item.author}）`;
    const source = document.createElement("span");
    source.textContent = `${item.source === "builtin" ? "内置插件" : "用户插件"} · API v${item.apiVersion} · ${item.path}`;
    source.style.fontSize = "12px";
    source.style.opacity = "0.72";
    info.append(name, description, source);
    if (item.error) {
      const persistentError = document.createElement("span");
      persistentError.textContent = `错误：${item.error}`;
      persistentError.style.color = "#e5484d";
      persistentError.style.fontSize = "12px";
      info.appendChild(persistentError);
    }

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";

    if (item.status === "running" && item.canOpen) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "save-btn save-btn--ghost";
      open.textContent = "打开";
      open.addEventListener("click", async () => {
        open.disabled = true;
        try {
          const result = await api.open(item.id);
          if (!result.ok) appendTransientError(row, `打开失败：${result.error ?? "未知错误"}`);
        } catch (error) {
          appendTransientError(row, `打开失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          open.disabled = false;
        }
      });
      actions.appendChild(open);
    }

    if (item.status === "failed") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "save-btn save-btn--ghost";
      retry.textContent = "重试";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          const result = await api.setEnabled(item.id, true);
          if (!result.ok) appendTransientError(row, `重试失败：${result.error ?? "未知错误"}`);
          await renderFeaturePlugins(api, list, rescanButton);
        } catch (error) {
          appendTransientError(row, `重试失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          retry.disabled = false;
        }
      });
      actions.appendChild(retry);
    }

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = item.configuredEnabled ? "save-btn" : "save-btn save-btn--ghost";
    toggle.textContent = item.configuredEnabled ? "停用" : "启用";
    toggle.disabled = item.status === "starting" || item.status === "stopping";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      const targetEnabled = !item.configuredEnabled;
      try {
        const result = await api.setEnabled(item.id, targetEnabled);
        if (!result.ok) {
          appendTransientError(row, `切换失败：${result.error ?? "未知错误"}`);
        }
        await renderFeaturePlugins(api, list, rescanButton);
      } catch (error) {
        appendTransientError(row, `切换失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        toggle.disabled = false;
      }
    });
    actions.appendChild(toggle);

    if (item.source === "user") {
      const uninstall = document.createElement("button");
      uninstall.type = "button";
      uninstall.className = "save-btn save-btn--ghost";
      uninstall.textContent = "卸载";
      uninstall.disabled = item.status === "starting" || item.status === "stopping";
      uninstall.addEventListener("click", async () => {
        const confirmed = window.confirm(
          `确定卸载用户插件“${item.name}”吗？\n\n将删除插件程序目录，但保留 userData/plugin-data 中的插件数据。`,
        );
        if (!confirmed) return;
        uninstall.disabled = true;
        try {
          const result = await api.uninstall(item.id);
          if (!result.ok) {
            appendTransientError(row, `卸载失败：${result.error ?? "未知错误"}`);
            return;
          }
          await renderFeaturePlugins(api, list, rescanButton);
        } catch (error) {
          appendTransientError(row, `卸载失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          uninstall.disabled = false;
        }
      });
      actions.appendChild(uninstall);
    }
    row.append(info, actions);
    list.appendChild(row);
  }
}
