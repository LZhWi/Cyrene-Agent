import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./ToolModePanel.css";

type PanelTab = "general" | "work" | "code" | "learn";
type ToolMode = "work" | "code" | "learn";

interface ToolCatalogItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  modes: Array<"chat" | "work" | "code" | "learn"> | null;
  deprecated: string | null;
}

type Overrides = Record<string, Partial<Record<string, boolean>>>;

const TABS: Array<{ key: PanelTab; label: string }> = [
  { key: "general", label: "通用" },
  { key: "work", label: "Work" },
  { key: "code", label: "Code" },
  { key: "learn", label: "Learn" },
];

const TOOL_MODES: ToolMode[] = ["work", "code", "learn"];

// TODO: 为每个工具配置专属 SVG 图标；key 为工具 id，未配置时使用占位图标。
const TOOL_ICON_SVGS: Record<string, React.ReactNode> = {};

/** 占位图标（后续逐个替换为工具专属 SVG） */
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
function visibleInMode(tool: ToolCatalogItem, mode: ToolMode, overrides: Overrides): boolean {
  const override = overrides[tool.id]?.[mode];
  if (override !== undefined) return override;
  if (!tool.modes) return true;
  return tool.modes.includes(mode);
}

/** 通用页签：三个模式均未显式关闭即视为开启 */
function visibleInGeneral(tool: ToolCatalogItem, overrides: Overrides): boolean {
  return TOOL_MODES.every((m) => overrides[tool.id]?.[m] !== false);
}

export const ToolModePanel: React.FC = () => {
  const [tools, setTools] = useState<ToolCatalogItem[]>([]);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<PanelTab>("general");

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

  const toggleGeneral = useCallback((toolId: string, next: boolean) => {
    if (next) {
      // 恢复默认：清除该工具的全部模式覆盖
      setOverrides((prev) => {
        const rest = { ...prev };
        delete rest[toolId];
        return rest;
      });
      void window.settings
        ?.clearToolModeOverride?.(toolId)
        ?.catch((err) => console.warn("[ToolModePanel] clear override failed:", err));
    } else {
      setOverrides((prev) => ({
        ...prev,
        [toolId]: { ...prev[toolId], work: false, code: false, learn: false },
      }));
      for (const m of TOOL_MODES) {
        void window.settings
          ?.setToolModeOverride?.(toolId, m, false)
          ?.catch((err) => console.warn("[ToolModePanel] set override failed:", err));
      }
    }
  }, []);

  const visibleTools = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    const usable = tools.filter((t) => t.enabled && !t.deprecated);
    // 通用页签只展示"未声明 modes、默认全模式可见"的工具
    const scoped = tab === "general" ? usable.filter((t) => !t.modes) : usable;
    const searched = kw
      ? scoped.filter(
          (t) =>
            t.id.toLowerCase().includes(kw) ||
            t.name.toLowerCase().includes(kw) ||
            t.description.toLowerCase().includes(kw),
        )
      : scoped;
    const isOn = (t: ToolCatalogItem) =>
      tab === "general" ? visibleInGeneral(t, overrides) : visibleInMode(t, tab, overrides);
    return [...searched].sort((a, b) => {
      const va = isOn(a) ? 0 : 1;
      const vb = isOn(b) ? 0 : 1;
      if (va !== vb) return va - vb;
      return a.id.localeCompare(b.id);
    });
  }, [tools, overrides, filter, tab]);

  return (
    <div className="tool-panel">
      <header className="tool-panel__header">
        <h1 className="tool-panel__title">工具</h1>
        <p className="tool-panel__subtitle">为 Work / Code / Learn 模式配置可用工具</p>
      </header>

      <div className="tool-panel__search-row">
        <input
          className="tool-panel__search"
          placeholder="搜索工具…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <nav className="tool-panel__tabs">
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
      </nav>

      {loading ? (
        <div className="tool-panel__loading">加载中…</div>
      ) : (
        <div className="tool-panel__grid">
          {visibleTools.map((tool) => {
            const on =
              tab === "general"
                ? visibleInGeneral(tool, overrides)
                : visibleInMode(tool, tab, overrides);
            const overridden =
              tab === "general"
                ? overrides[tool.id] !== undefined
                : overrides[tool.id]?.[tab] !== undefined;
            return (
              <div key={tool.id} className={"tool-card" + (on ? "" : " is-off")}>
                <ToolIcon toolId={tool.id} />
                <div className="tool-card__body">
                  <div className="tool-card__name">
                    {tool.name}
                    {overridden && <span className="tool-card__badge">已覆盖</span>}
                  </div>
                  <div className="tool-card__desc">{tool.description.split("\n")[0]}</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  className={"tool-card__pill" + (on ? " is-on" : "")}
                  onClick={() =>
                    tab === "general"
                      ? toggleGeneral(tool.id, !on)
                      : toggleMode(tool.id, tab, !on)
                  }
                >
                  <span className="tool-card__pill-knob" />
                </button>
              </div>
            );
          })}
          {visibleTools.length === 0 && (
            <div className="tool-panel__empty">无匹配工具</div>
          )}
        </div>
      )}
    </div>
  );
};

export default ToolModePanel;
