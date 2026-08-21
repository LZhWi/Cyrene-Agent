// 上下文容量观看器：composer footer 右侧的环形进度控件 + 占比菜单。
//
// 数据来源：assistant 消息的 contextUsage 快照（主进程每轮 preRequest 实时推送、
// run 终态持久化，见 docs/context-usage-viewer-construction-plan.md）。
// - 无快照 → 不渲染（不占位）。
// - 占用比 = totalTokens / contextWindowTokens；SVG 弧长只吃 clamp 后的
//   visualRatio（ratio>1 时文本诚实显示如 118%，圆环 clamp 到整圈）。
// - 颜色分级：正常主题强调色；≥70% 暖色；≥90% 警示红。仅变色，无动画。
// - 菜单趣味性：按档位切换 Cyrene 小人（开心/提醒/担心）+ 一句拟人提示。
import { Popover } from "antd";
import { useState } from "react";
import type { ContextUsageCategoryKey, ContextUsageSnapshot } from "../../../../../shared/context-usage";
import { resolveAsset } from "../../../../../shared/renderer-base";
import "./ContextUsageRing.css";

const RING_SIZE = 20;
const RING_STROKE = 3;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
/** 导出供单测断言弧长比例；圆环几何的唯一事实源。 */
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export const CONTEXT_USAGE_CATEGORY_META: Record<ContextUsageCategoryKey, { label: string; color: string }> = {
  systemPrompt: { label: "系统提示词", color: "#8B5CF6" },
  tools: { label: "工具", color: "#3B82F6" },
  skills: { label: "技能", color: "#06B6D4" },
  runtimeAndToolLogs: { label: "运行时与日志", color: "#F59E0B" },
  conversation: { label: "对话历史", color: "#10B981" },
  other: { label: "其他", color: "#9CA3AF" },
  // 旧快照兼容（拆分前"工具与 Skill"合一）；新快照不再产出此 key。
  toolDefinitions: { label: "工具与 Skill", color: "#3B82F6" },
};

/** 三档趣味性小人：normal / warm / alert；素材走 public 目录，不进 bundle。
 *  当前为占位图，后续直接替换 public/context-usage/ 下的同名文件即可。 */
export const CONTEXT_USAGE_MOOD_META: Record<ContextUsageRingTone, { src: string; text: string }> = {
  normal: { src: resolveAsset("context-usage/normal.png"), text: "还很宽敞，随便聊~" },
  warm: { src: resolveAsset("context-usage/warm.png"), text: "有点满了，等下我帮你整理" },
  alert: { src: resolveAsset("context-usage/alert.png"), text: "快撑不住啦，建议新开对话" },
};

/** 数字格式：>=1000 显示 12.3k（>=100k 取整），否则原值。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(Math.round(value));
}

/** 占用比；窗口非法（<=0）时返回 NaN，由调用方决定是否展示百分比。 */
export function computeUsageRatio(totalTokens: number, contextWindowTokens: number): number {
  if (!Number.isFinite(totalTokens) || !Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
    return Number.NaN;
  }
  return totalTokens / contextWindowTokens;
}

/** 只喂给 SVG 的弧长比例：clamp 到 [0,1]，NaN/Infinity 归 0。 */
export function clampVisualRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.min(1, Math.max(0, ratio));
}

export type ContextUsageRingTone = "normal" | "warm" | "alert";

/** 颜色分级：≥90% 警示红；≥70% 暖色（逼近压缩阈值）；否则主题强调色。 */
export function resolveRingTone(ratio: number): ContextUsageRingTone {
  if (!Number.isFinite(ratio)) return "normal";
  if (ratio >= 0.9) return "alert";
  if (ratio >= 0.7) return "warm";
  return "normal";
}

export function ContextUsageRing({ usage }: { usage?: ContextUsageSnapshot }) {
  const [open, setOpen] = useState(false);
  if (!usage) return null;

  const ratio = computeUsageRatio(usage.totalTokens, usage.contextWindowTokens);
  const showRatio = Number.isFinite(ratio);
  const visualRatio = clampVisualRatio(ratio);
  const tone = resolveRingTone(ratio);
  const percentText = showRatio ? `${Math.round(ratio * 100)}%` : undefined;
  const summaryText = showRatio
    ? `${formatTokenCount(usage.totalTokens)} / ${formatTokenCount(usage.contextWindowTokens)} tokens (${percentText})`
    : `${formatTokenCount(usage.totalTokens)} tokens`;
  const title = `上下文 ${summaryText.replace(" tokens ", " ")}`;

  // 明细行按 token 从大到小排队，大头一眼置顶。
  const visibleCategories = usage.categories
    .filter((category) => category.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  const menu = (
    <div className="cy-context-usage-menu" aria-label="上下文占比">
      <div className="cy-context-usage-menu__header">
        <strong>上下文容量</strong>
        <span>{summaryText}</span>
      </div>
      <div className={`cy-context-usage-menu__progress is-${tone}`} aria-hidden="true">
        <span style={{ width: `${visualRatio * 100}%` }} />
      </div>
      <div className={`cy-context-usage-menu__mood is-${tone}`}>
        <img src={CONTEXT_USAGE_MOOD_META[tone].src} alt="" aria-hidden="true" draggable={false} />
        <span>{CONTEXT_USAGE_MOOD_META[tone].text}</span>
      </div>
      <ul className="cy-context-usage-menu__rows">
        {visibleCategories.map((category, index) => {
          const meta = CONTEXT_USAGE_CATEGORY_META[category.key];
          // 占已用比例：各类加总恒 100%，直观看构成；与顶行"占窗口容量"互补。
          const share = usage.totalTokens > 0
            ? Math.round((category.tokens / usage.totalTokens) * 100)
            : undefined;
          // 圆点用分类色，透明度按排序位次递减（榜首最实，往下渐淡）。
          const dotOpacity = Math.max(0.25, 1 - index * 0.15);
          return (
            <li key={category.key}>
              <span
                className="cy-context-usage-menu__dot"
                style={{ background: meta.color, opacity: dotOpacity }}
                aria-hidden="true"
              />
              <span className="cy-context-usage-menu__name">{meta.label}</span>
              <span className="cy-context-usage-menu__tokens">{formatTokenCount(category.tokens)}</span>
              {share !== undefined && <span className="cy-context-usage-menu__share">{share}%</span>}
            </li>
          );
        })}
      </ul>
      <div className="cy-context-usage-menu__footnote">估算值（按字符折算），对话后自动刷新</div>
    </div>
  );

  return (
    <Popover
      content={menu}
      trigger="click"
      placement="topRight"
      open={open}
      onOpenChange={setOpen}
      rootClassName="cy-context-usage-popover"
    >
      <button
        type="button"
        className={`cy-context-usage-ring is-${tone}`}
        aria-label={title}
        title={title}
        onClick={() => setOpen(!open)}
      >
        <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} aria-hidden="true">
          <circle
            className="cy-context-usage-ring__track"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
          />
          {visualRatio > 0 && (
            <circle
              className="cy-context-usage-ring__progress"
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={`${visualRatio * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
              transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            />
          )}
        </svg>
      </button>
    </Popover>
  );
}
