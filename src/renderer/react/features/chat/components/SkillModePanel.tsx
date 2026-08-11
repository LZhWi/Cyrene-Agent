import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./SkillModePanel.css";

type SkillFilter = "all" | "project" | "user";

interface SkillUiEntry {
  id: string;
  name: string;
  description: string;
  tools: string[];
  enabled: boolean;
  source: "builtin" | "user";
  version?: string;
  references: string[];
}

const FILTERS: Array<{ key: SkillFilter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "project", label: "项目" },
  { key: "user", label: "个人" },
];

function scopeLabel(source: string) {
  return source === "user" ? "个人" : "项目";
}

function hashHue(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function PlaceholderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" fill="none">
      <path
        d="M24 6L30 18H42L32 27L36 41L24 33L12 41L16 27L6 18H18L24 6Z"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SkillIcon({ id }: { id: string }) {
  const hue = hashHue(id);
  return (
    <span
      className="skill-card__icon"
      style={{ background: `hsl(${hue}, 82%, 94%)`, color: `hsl(${hue}, 55%, 42%)` }}
    >
      <PlaceholderIcon />
    </span>
  );
}

export const SkillModePanel: React.FC = () => {
  const [skills, setSkills] = useState<SkillUiEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState<SkillFilter>("all");

  const load = useCallback(() => {
    setLoading(true);
    window.settings
      ?.listSkills?.()
      ?.then((list) => {
        setSkills((list as SkillUiEntry[]) ?? []);
      })
      .catch((err) => console.warn("[SkillModePanel] load failed:", err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = useCallback((id: string, next: boolean) => {
    setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: next } : s)));
    void window.settings
      ?.setSkillEnabled?.(id, next)
      ?.then((res) => {
        if (res && !res.ok) throw new Error(res.error);
      })
      .catch((err) => {
        console.warn("[SkillModePanel] set enabled failed:", err);
        // 失败回滚
        setSkills((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !next } : s)));
      });
  }, []);

  const visibleSkills = useMemo(() => {
    const kw = filter.trim().toLowerCase();
    let list = skills;
    if (scope !== "all") {
      list = list.filter((s) => (scope === "user" ? s.source === "user" : s.source !== "user"));
    }
    if (kw) {
      list = list.filter(
        (s) =>
          s.id.toLowerCase().includes(kw) ||
          s.name.toLowerCase().includes(kw) ||
          s.description.toLowerCase().includes(kw) ||
          s.tools.some((t) => t.toLowerCase().includes(kw)),
      );
    }
    return [...list].sort((a, b) => {
      // 启用的排前面，再按 id
      if (a.enabled !== b.enabled) return (a.enabled ? 0 : 1) - (b.enabled ? 0 : 1);
      return a.id.localeCompare(b.id);
    });
  }, [skills, scope, filter]);

  return (
    <div className="skill-panel">
      <header className="skill-panel__header">
        <h1 className="skill-panel__title">技能</h1>
        <p className="skill-panel__subtitle">管理项目级与用户级技能。启用后可在聊天里通过 $skill-name 使用。</p>
      </header>

      <div className="skill-panel__toolbar">
        <input
          className="skill-panel__search"
          placeholder="搜索技能…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="skill-panel__filter"
          value={scope}
          onChange={(e) => setScope(e.target.value as SkillFilter)}
        >
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="skill-panel__loading">加载中…</div>
      ) : (
        <div className="skill-panel__list">
          <div className="skill-panel__count">
            工作区与个人技能
            <span className="skill-panel__count-num">{visibleSkills.length}</span> 项
          </div>
          {visibleSkills.map((skill) => (
            <div key={skill.id} className={"skill-card" + (skill.enabled ? "" : " is-off")}>
              <SkillIcon id={skill.id} />
              <div className="skill-card__body">
                <div className="skill-card__name">{skill.id}</div>
                <div className="skill-card__desc">{skill.description || "暂无描述"}</div>
              </div>
              <div className="skill-card__meta">
                <span className="skill-card__scope">{scopeLabel(skill.source)}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={skill.enabled}
                  className={"skill-card__pill" + (skill.enabled ? " is-on" : "")}
                  onClick={() => toggle(skill.id, !skill.enabled)}
                >
                  <span className="skill-card__pill-knob" />
                </button>
              </div>
            </div>
          ))}
          {visibleSkills.length === 0 && <div className="skill-panel__empty">无匹配技能</div>}
        </div>
      )}
    </div>
  );
};

export default SkillModePanel;
