import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./ToolModePanel.css";

type ToolMode = "work" | "code" | "learn";

type TabKey = ToolMode;

interface ToolCatalogItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  modes: Array<"chat" | "work" | "code" | "learn"> | null;
  deprecated: string | null;
}

type Overrides = Record<string, Partial<Record<string, boolean>>>;

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "work", label: "Work" },
  { key: "code", label: "Code" },
  { key: "learn", label: "Learn" },
];

function GithubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M24 4C12.9543 4 4 12.9543 4 24C4 35.0457 12.9543 44 24 44C35.0457 44 44 35.0457 44 24C44 12.9543 35.0457 4 24 4ZM0 24C0 10.7452 10.7452 0 24 0C37.2548 0 48 10.7452 48 24C48 37.2548 37.2548 48 24 48C10.7452 48 0 37.2548 0 24Z"
        fill="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M19.1833 45.4716C18.9898 45.2219 18.9898 42.9973 19.1833 38.798C17.1114 38.8696 15.8024 38.7258 15.2563 38.3667C14.437 37.828 13.6169 36.1667 12.8891 34.9959C12.1614 33.8251 10.5463 33.64 9.89405 33.3783C9.24182 33.1165 9.07809 32.0496 11.6913 32.8565C14.3044 33.6634 14.4319 35.8607 15.2563 36.3745C16.0806 36.8883 18.0515 36.6635 18.9448 36.2519C19.8382 35.8403 19.7724 34.3078 19.9317 33.7007C20.1331 33.134 19.4233 33.0083 19.4077 33.0037C18.5355 33.0037 13.9539 32.0073 12.6955 27.5706C11.437 23.134 13.0581 20.2341 13.9229 18.9875C14.4995 18.1564 14.4485 16.3852 13.7699 13.6737C16.2335 13.3589 18.1347 14.1343 19.4734 16.0001C19.4747 16.0108 21.2285 14.9572 24.0003 14.9572C26.772 14.9572 27.7553 15.8154 28.5142 16.0001C29.2731 16.1848 29.88 12.7341 34.5668 13.6737C33.5883 15.5969 32.7689 18.0001 33.3943 18.9875C34.0198 19.9749 36.4745 23.1147 34.9666 27.5706C33.9614 30.5413 31.9853 32.3523 29.0384 33.0037C28.7005 33.1115 28.5315 33.2855 28.5315 33.5255C28.5315 33.8856 28.9884 33.9249 29.6465 35.6117C30.0853 36.7362 30.117 39.948 29.7416 45.247C28.7906 45.4891 28.0508 45.6516 27.5221 45.7347C26.5847 45.882 25.5669 45.9646 24.5669 45.9965C23.5669 46.0284 23.2196 46.0248 21.837 45.8961C20.9154 45.8103 20.0308 45.6688 19.1833 45.4716Z"
        fill="currentColor"
      />
    </svg>
  );
}

function PlaceholderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
      <circle cx="24" cy="24" r="16" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeDasharray="6 4" />
      <path d="M24 16V32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      <path d="M16 24H32" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

// TODO: 为每个工具配置专属 SVG 图标；key 为工具 id，未配置时使用占位图标。
const TOOL_ICON_SVGS: Record<string, React.ReactNode> = {
  // Git 相关工具
  git_status: <GithubIcon />,
  git_init: <GithubIcon />,
  git_commit: <GithubIcon />,
  git_switch_branch: <GithubIcon />,
  git_push: <GithubIcon />,
  git_revert: <GithubIcon />,
  // 代码功能工具
  search_code: <GithubIcon />,
  lsp: <GithubIcon />,
  apply_patch: <GithubIcon />,
  str_replace: <GithubIcon />,
  ast_grep_search: <GithubIcon />,
  ast_grep_replace: <GithubIcon />,
  run_shell: <GithubIcon />,
  run_verification: <GithubIcon />,
};

function ToolIcon({ toolId }: { toolId: string }) {
  return (
    <span
      className="tool-card__icon"
      style={{
        background: "var(--cy-bg-page, #f5f5f5)",
        color: "var(--cy-text-muted, #6e6e73)",
      }}
    >
      {TOOL_ICON_SVGS[toolId] ?? <PlaceholderIcon />}
    </span>
  );
}

/** 与主进程 getEnabledToolsForMode 同源的默认可见性计算（前端镜像） */
function isVisibleForMode(tool: ToolCatalogItem, mode: ToolMode, overrides: Overrides): boolean {
  const override = overrides[tool.id]?.[mode];
  if (override !== undefined) return override;
  if (!tool.modes) return true;
  return tool.modes.includes(mode);
}

export const ToolModePanel: React.FC = () => {
  const [tools, setTools] = useState<ToolCatalogItem[]>([]);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<TabKey>("code");

  useEffect(() => {
    let cancelled = false;
    const api = window.settings;
    Promise.all([
      api?.getToolCatalog?.() ?? Promise.resolve([]),
      api?.getToolModeOverrides?.() ?? Promise.resolve({}),
    ])
      .then(([catalog, ov]) => {
        if (cancelled) return;
        setTools(catalog as ToolCatalogItem[]);
        setOverrides(ov as Overrides);
      })
      .catch((err) => console.warn("[ToolModePanel] load failed:", err))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const toggleMode = useCallback((toolId: string, mode: ToolMode, next: boolean) => {
    setOverrides((prev) => ({
      ...prev,
      [toolId]: { ...prev[toolId], [mode]: next },
    }));
    void window.settings
      ?.setToolModeOverride?.(toolId, mode, next)
      ?.catch((err) => console.warn("[ToolModePanel] set override failed:", err));
  }, []);

  const visibleTools = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    const usable = tools.filter((t) => !t.deprecated);
    const shown = usable.filter((t) => t.enabled && isVisibleForMode(t, tab, overrides));
    const searched = kw
      ? shown.filter(
          (t) =>
            t.id.toLowerCase().includes(kw) ||
            t.name.toLowerCase().includes(kw) ||
            t.description.toLowerCase().includes(kw),
        )
      : shown;
    return [...searched].sort((a, b) => {
      const aOn = isVisibleForMode(a, tab, overrides);
      const bOn = isVisibleForMode(b, tab, overrides);
      if (aOn !== bOn) return aOn ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [tools, overrides, filter, tab]);

  return (
    <div className="tool-panel">
      <header className="tool-panel__header">
        <h1 className="tool-panel__title">工具</h1>
        <p className="tool-panel__subtitle">
          {`管理工具在 ${TABS.find((t) => t.key === tab)?.label} 模式下的可见性`}
        </p>
      </header>

      <div className="tool-panel__search-row">
        <input
          className="tool-panel__search"
          placeholder="搜索工具…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="tool-panel__tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={"tool-panel__tab" + (tab === t.key ? " is-active" : "")}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="tool-panel__loading">加载中…</div>
      ) : (
        <div className="tool-panel__grid">
          {visibleTools.map((tool) => {
            const isOn = isVisibleForMode(tool, tab, overrides);
            return (
              <div key={tool.id} className={"tool-card" + (isOn ? "" : " is-off")}>
                <ToolIcon toolId={tool.id} />
                <div className="tool-card__body">
                  <div className="tool-card__name">
                    {tool.name}
                    {!tool.enabled && <span className="tool-card__badge">已禁用</span>}
                  </div>
                  <div className="tool-card__desc">{tool.description.split("\n")[0] || "暂无描述"}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  className={"tool-card__pill" + (isOn ? " is-on" : "")}
                  onClick={() => toggleMode(tool.id, tab, !isOn)}
                >
                  <span className="tool-card__pill-knob" />
                </button>
              </div>
            );
          })}
          {visibleTools.length === 0 && <div className="tool-panel__empty">无匹配工具</div>}
        </div>
      )}
    </div>
  );
};

export default ToolModePanel;
