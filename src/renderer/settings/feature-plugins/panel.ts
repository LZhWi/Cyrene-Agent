import { featurePluginsList } from "./dom";

export interface FeaturePluginListEntry {
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

export interface FeaturePluginsApi {
  list(): Promise<FeaturePluginListEntry[]>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  open(id: string): Promise<{ ok: boolean; error?: string }>;
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
  setTimeout(() => error.remove(), 4000);
}

export async function renderFeaturePlugins(
  api: FeaturePluginsApi | undefined = window.plugins,
  list: HTMLElement | null = featurePluginsList,
): Promise<void> {
  if (!list || !api) return;
  let items: FeaturePluginListEntry[];
  try {
    items = await api.list();
  } catch (error) {
    list.replaceChildren();
    const failure = document.createElement("div");
    failure.className = "settings-empty";
    failure.textContent = `插件列表加载失败：${error instanceof Error ? error.message : String(error)}`;
    list.appendChild(failure);
    return;
  }
  list.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "settings-empty";
    empty.textContent = "暂无插件：把插件目录放进 userData/plugins/ 后重启生效";
    list.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "setting-row";
    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = `${item.name} v${item.version}`;
    const description = document.createElement("span");
    description.textContent = `${item.description}（${item.author}）`;
    info.append(name, description);

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";

    if (item.enabled && item.canOpen) {
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

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = item.enabled ? "save-btn" : "save-btn save-btn--ghost";
    toggle.textContent = item.enabled ? "已启用" : "已停用";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        const result = await api.setEnabled(item.id, !item.enabled);
        if (!result.ok) {
          appendTransientError(row, `切换失败：${result.error ?? "未知错误"}`);
          return;
        }
        await renderFeaturePlugins(api, list);
      } catch (error) {
        appendTransientError(row, `切换失败：${error instanceof Error ? error.message : String(error)}`);
      } finally {
        toggle.disabled = false;
      }
    });
    actions.appendChild(toggle);
    row.append(info, actions);
    list.appendChild(row);
  }
}
