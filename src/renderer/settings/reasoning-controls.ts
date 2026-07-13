// 渲染端推理控件渲染函数。从 settings.ts 抽出以便独立单元测试。
//
// 控件形态（按 capability.control）：
// - fixed-on：不渲染三按钮，改为单段"始终开启"文案（用户第二轮修订 #3）
// - dynamic：控件整体禁用，文案"跟随火山动态路由"
// - none：只允许 auto，文案"未配置推理控制"
// - toggle / effort / toggle-effort：三按钮 + effort 行（按 supportedEfforts 动态生成）
//
// saved 永远不动；本函数只渲染当前 UI 状态。

import {
  resolveEffectiveReasoning,
  resolveReasoningCapability,
  type ReasoningEffort,
  type ReasoningMode,
  type ReasoningPreference,
} from "../../shared/reasoning";

export const EFFORT_LABEL: Record<ReasoningEffort, string> = {
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最强",
};

export interface ReasoningDomRefs {
  modeRow: HTMLElement;
  modeControls: HTMLElement;
  effortRow: HTMLElement;
  effortControls: HTMLElement;
  fixedOnRow: HTMLElement;
  statusNote: HTMLElement;
}

/** 纯函数：计算 UI 应展示的状态（不触碰 DOM）。便于无 DOM 环境单测。 */
export function computeReasoningView(
  provider: string,
  model: string,
  saved: ReasoningPreference | undefined,
): {
  capabilityControl: "none" | "toggle" | "effort" | "toggle-effort" | "fixed-on" | "dynamic";
  modeRowHidden: boolean;
  effortRowHidden: boolean;
  fixedOnRowHidden: boolean;
  /** 各 mode 按钮是否 disabled */
  modeDisabled: Record<ReasoningMode, boolean>;
  /** 当前高亮的 mode */
  activeMode: ReasoningMode;
  /** effort 行是否显示（如显示，下方给出按钮列表） */
  effortButtons: { effort: ReasoningEffort; label: string; active: boolean }[];
  statusText: string;
} {
  const cap = resolveReasoningCapability(provider, model);
  const effective = resolveEffectiveReasoning(saved, cap);

  if (cap.control === "fixed-on") {
    return {
      capabilityControl: "fixed-on",
      modeRowHidden: true,
      effortRowHidden: true,
      fixedOnRowHidden: false,
      modeDisabled: { auto: false, off: false, on: false },
      activeMode: effective.mode,
      effortButtons: [],
      statusText: "",
    };
  }

  if (cap.control === "dynamic") {
    return {
      capabilityControl: "dynamic",
      modeRowHidden: false,
      effortRowHidden: true,
      fixedOnRowHidden: true,
      modeDisabled: { auto: true, off: true, on: true },
      activeMode: effective.mode,
      effortButtons: [],
      statusText: "思考模式：跟随火山动态路由（不可调整）",
    };
  }

  if (cap.control === "none") {
    return {
      capabilityControl: "none",
      modeRowHidden: false,
      effortRowHidden: true,
      fixedOnRowHidden: true,
      modeDisabled: { auto: false, off: true, on: true },
      activeMode: effective.mode,
      effortButtons: [],
      statusText: "当前模型未配置推理控制，将跟随厂商默认值",
    };
  }

  // toggle / effort / toggle-effort
  const modeDisabled: Record<ReasoningMode, boolean> = { auto: false, off: false, on: false };
  const effortButtons = (cap.supportedEfforts ?? []).map(e => ({
    effort: e,
    label: EFFORT_LABEL[e],
    active: e === effective.effort,
  }));

  let statusText = "";
  if (cap.control === "toggle") {
    statusText = "支持开关思考模式";
  } else {
    statusText = "支持开关与强度选择";
  }
  if (saved?.effort && saved.effort !== effective.effort && effective.effort) {
    statusText += `；你之前选的 ${saved.effort} 不被该模型支持，当前实际档位：${effective.effort}`;
  } else if (saved?.effort && !effective.effort && cap.supportedEfforts) {
    statusText += `；你之前选的 ${saved.effort} 不被该模型支持，当前未应用强度档位`;
  }

  return {
    capabilityControl: cap.control,
    modeRowHidden: false,
    effortRowHidden: effortButtons.length === 0,
    fixedOnRowHidden: true,
    modeDisabled,
    activeMode: effective.mode,
    effortButtons,
    statusText,
  };
}

/** 把 view 状态应用到 DOM。settings.ts 在浏览器环境调用。 */
export function renderReasoningControls(
  provider: string,
  model: string,
  saved: ReasoningPreference | undefined,
  refs: ReasoningDomRefs,
): void {
  const v = computeReasoningView(provider, model, saved);

  refs.modeRow.hidden = v.modeRowHidden;
  refs.effortRow.hidden = v.effortRowHidden;
  refs.fixedOnRow.hidden = v.fixedOnRowHidden;
  refs.statusNote.textContent = v.statusText;

  // mode 按钮
  if (!v.modeRowHidden) {
    refs.modeControls.querySelectorAll<HTMLButtonElement>(".option-block").forEach((btn) => {
      const mode = btn.dataset.reasoningMode as ReasoningMode;
      btn.disabled = v.modeDisabled[mode];
      btn.setAttribute("aria-pressed", String(mode === v.activeMode));
      btn.classList.toggle("is-active", mode === v.activeMode);
    });
  }

  // effort 按钮
  refs.effortControls.replaceChildren();
  if (!v.effortRowHidden) {
    for (const e of v.effortButtons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option-block";
      btn.dataset.reasoningEffort = e.effort;
      btn.textContent = e.label;
      btn.classList.toggle("is-active", e.active);
      btn.setAttribute("aria-pressed", String(e.active));
      refs.effortControls.appendChild(btn);
    }
  }
}