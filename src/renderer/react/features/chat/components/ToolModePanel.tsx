import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./ToolModePanel.css";

type ToolMode = "work" | "code" | "learn";

type TabKey = "general" | ToolMode;

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
  { key: "general", label: "通用" },
  { key: "work", label: "Work" },
  { key: "code", label: "Code" },
  { key: "learn", label: "Learn" },
];

// TODO: 为每个工具配置专属 SVG 图标；key 为工具 id，未配置时使用占位图标。
const TOOL_ICON_SVGS: Record<string, React.ReactNode> = {};

function PlaceholderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
      <rect x="8" y="8" width="32" height="32" rx="8" stroke="currentColor" strokeWidth="3.5" />
      <path d="M18 24h12M24 18v12" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}

function hashHue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function ToolIcon({ toolId }: { toolId: string }) {
  const hue = hashHue(toolId);
  return (
    <span
      className="tool-card__icon"
      style={{ background: `hsl(${hue}, 82%, 94%)`, color: `hsl(${hue}, 55%, 42%)` }}
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
  const [tab, setTab] = useState<TabKey>("general");

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

  const toggleGeneral = useCallback((toolId: string, next: boolean) => {
    setTools((prev) =>
      prev.map((t) => (t.id === toolId ? { ...t, enabled: next } : t)),
    );
    void window.settings
      ?.setToolEnabled?.(toolId, next)
      ?.catch((err) => console.warn("[ToolModePanel] set enabled failed:", err));
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
    const candidates = tab === "general" ? usable : usable.filter((t) => t.enabled);
    const searched = kw
      ? candidates.filter(
          (t) =>
            t.id.toLowerCase().includes(kw) ||
            t.name.toLowerCase().includes(kw) ||
            t.description.toLowerCase().includes(kw),
        )
      : candidates;
    return [...searched].sort((a, b) => {
      const aOn = tab === "general" ? a.enabled : isVisibleForMode(a, tab, overrides);
      const bOn = tab === "general" ? b.enabled : isVisibleForMode(b, tab, overrides);
      if (aOn !== bOn) return aOn ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
  }, [tools, overrides, filter, tab]);

  return (
    <div className="tool-panel">
      <header className="tool-panel__header">
        <h1 className="tool-panel__title">工具</h1>
        <p className="tool-panel__subtitle">
          {tab === "general"
            ? "管理工具的全局开关"
            : `管理工具在 ${TABS.find((t) => t.key === tab)?.label} 模式下的可见性`}
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
            const isOn =
              tab === "general" ? tool.enabled : isVisibleForMode(tool, tab, overrides);
            return (
              <div key={tool.id} className={"tool-card" + (isOn ? "" : " is-off")}>
                <ToolIcon toolId={tool.id} />
                <div className="tool-card__body">
                  <div className="tool-card__name">
                    {tool.name}
                    {tab !== "general" && !tool.enabled && (
                      <span className="tool-card__badge">已禁用</span>
                    )}
                  </div>
                  <div className="tool-card__desc">{tool.description.split("\n")[0] || "暂无描述"}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isOn}
                  className={"tool-card__pill" + (isOn ? " is-on" : "")}
                  onClick={() =>
                    tab === "general"
                      ? toggleGeneral(tool.id, !isOn)
                      : toggleMode(tool.id, tab, !isOn)
                  }
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
