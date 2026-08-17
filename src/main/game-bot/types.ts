// game-bot 类型定义 —— 脚本原语 + GameRecipe。
// 纯类型，无副作用。id 永远 = 脚本文件名（去 .yaml），name 仅展示。

// ── 原语 ──────────────────────────────────────────────────
// 每个原语一个 interface；Step 是联合类型。branch.then/else 递归为 Step[]。

export interface StepLaunch { type: "launch"; exe: string; }
export interface StepWait { type: "wait"; ms: number; }
export interface StepKey { type: "key"; combo: string; }  // "F4" / "Alt+F4"
export interface StepClick { type: "click"; target: "center" | { x: number; y: number }; }

export interface StepVlmClick {
  type: "vlm_click";
  ref: string;          // 参考小图名（红框裁出）
  target?: string;      // 给 VLM 的补充描述（可选）
  repeat?: number;      // 连点次数，默认 1
  interval?: number;    // 连点间隔 ms，默认 1000
  retry?: number;       // 定位失败重试次数，默认 2
  settle?: number;      // 截图前等待 ms，覆盖引擎默认
}

export interface StepVlmSelect {
  type: "vlm_select";
  desc: string;         // 语义描述，如"支援列表第一个"（无参考图）
  retry?: number;       // 默认 2
  settle?: number;
}

export interface StepVlmCheck {
  type: "vlm_check";
  id: string;           // 结果绑定到变量 ${id}（布尔），供 branch.if 用
  ask: string;
  ref?: string;         // 可选状态参考图
  settle?: number;
}

export interface StepVlmCompare {
  type: "vlm_compare";
  id: string;           // 结果绑定到变量 ${id}（匹配的 ref 索引或描述）
  ask: string;
  refs: string[];       // 多张参考图
  settle?: number;
}

export interface StepBranch {
  type: "branch";
  if: string;           // 表达式，如 "${has_update}" / "${auto_battle_state == 'off'}"
  then: Step[];
  else?: Step[];
}

export type Step =
  | StepLaunch | StepWait | StepKey | StepClick
  | StepVlmClick | StepVlmSelect | StepVlmCheck | StepVlmCompare
  | StepBranch;

export interface GameRecipe {
  name: string;
  exe: string;          // 可含 ${exe_path}
  model?: string;       // 可含 ${vlm_config}；留空则用全局 VLM 配置
  runner?: "steps" | "currency-wars" | "minecraft-player";
  steps: Step[];
}
