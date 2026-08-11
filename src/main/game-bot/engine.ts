// engine —— 步骤解释器。逐原语执行 GameRecipe，支持 branch/变量/settle/retry。
// 核心纯逻辑：通过 BotTools 接口调用工具（依赖注入），不直接 import screenshot/input/vlm，
// 因此可用 mock BotTools 单测。settle/sleep 也走注入，便于 fake timer。

import type { GameRecipe, Step } from "./types";
import type { BotTools, ProgressCb } from "./bot-tools";

export interface RunContext {
  tools: BotTools;
  vars?: Record<string, string>;      // 注入变量（exe_path / vlm_config 等）
  settleMs?: number;                   // vlm_* 截图前等待，默认 3000
  sleep?: (ms: number) => Promise<void>;
  onProgress?: ProgressCb;
  signal?: { aborted: boolean };       // 中止信号：true 则在当前步骤后停止
}

export interface RunResult {
  ok: boolean;
  error?: string;
  completed: number;
  total: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class RecipeAbortError extends Error {}

/** 替换 ${var} 为 vars 中的值。 */
function resolveVars(s: string, vars: Record<string, unknown>): string {
  return s.replace(/\$\{(\w+)\}/g, (_, k) => {
    const v = vars[k];
    return v === undefined ? "" : String(v);
  });
}

/**
 * 求 branch.if 表达式 → 布尔。
 * 支持 "${var}" / "${var == 'val'}" / "${var == 1}" / 裸 true/false。
 */
function evalExpr(expr: string, vars: Record<string, unknown>): boolean {
  const m = expr.trim().match(/^\$\{(\w+)\s*(?:==\s*(.+?))?\}$/);
  if (!m) {
    const r = resolveVars(expr, vars).trim().toLowerCase();
    return r === "true" || r === "1";
  }
  const name = m[1];
  const rhs = m[2];
  const val = vars[name];
  if (rhs === undefined) {
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return val !== 0;
    const s = String(val ?? "").trim().toLowerCase();
    return s === "true" || s === "1";
  }
  let r = rhs.trim();
  if ((r.startsWith("'") && r.endsWith("'")) || (r.startsWith('"') && r.endsWith('"'))) r = r.slice(1, -1);
  return String(val ?? "") === r;
}

function stepDesc(step: Step): string {
  switch (step.type) {
    case "launch": return "启动 " + step.exe;
    case "wait": return "等待 " + step.ms + "ms";
    case "key": return "按键 " + step.combo;
    case "click": return "点击 " + (step.target === "center" ? "中心" : JSON.stringify(step.target));
    case "vlm_click": return "识图点击 " + step.ref;
    case "vlm_select": return "语义选择 " + step.desc;
    case "vlm_check": return "判断 " + step.id;
    case "vlm_compare": return "比对 " + step.id;
    case "branch": return "分支 " + step.if;
  }
}

export async function runRecipe(recipe: GameRecipe, ctx: RunContext): Promise<RunResult> {
  const tools = ctx.tools;
  const vars: Record<string, unknown> = { ...(ctx.vars ?? {}) };
  vars.exe = resolveVars(recipe.exe, vars);
  if (recipe.model) vars.model = resolveVars(recipe.model, vars);
  const sleep = ctx.sleep
    ? async (ms: number) => {
        await ctx.sleep!(ms);
        if (ctx.signal?.aborted) throw new RecipeAbortError("已中止");
      }
    : async (ms: number) => {
        let remaining = ms;
        while (remaining > 0) {
          if (ctx.signal?.aborted) throw new RecipeAbortError("已中止");
          const chunk = Math.min(remaining, 100);
          await defaultSleep(chunk);
          remaining -= chunk;
        }
      };
  const settleMs = ctx.settleMs ?? 3000;
  const total = recipe.steps.length;
  let completed = 0;

  async function execStep(step: Step): Promise<string | null> {
    if (ctx.signal?.aborted) return "已中止";
    switch (step.type) {
      case "launch":
        await tools.launch(resolveVars(step.exe, vars));
        return null;
      case "wait":
        await sleep(step.ms);
        return null;
      case "key":
        await tools.key(step.combo);
        return null;
      case "click":
        if (step.target === "center") await tools.clickCenter();
        else await tools.click(step.target.x, step.target.y);
        return null;
      case "vlm_click": {
        await sleep(step.settle ?? settleMs);
        const tries = (step.retry ?? 2) + 1;
        let coord: { x: number; y: number } | null = null;
        for (let i = 0; i < tries; i++) {
          if (ctx.signal?.aborted) return "已中止";
          coord = await tools.locate(step.ref, step.target);
          if (coord) break;
          if (i < tries - 1) await sleep(1000);
        }
        if (!coord) return "vlm_click 定位失败: " + step.ref;
        const repeat = step.repeat ?? 1;
        for (let r = 0; r < repeat; r++) {
          await tools.click(coord.x, coord.y);
          if (r < repeat - 1) await sleep(step.interval ?? 1000);
        }
        return null;
      }
      case "vlm_select": {
        await sleep(step.settle ?? settleMs);
        const tries = (step.retry ?? 2) + 1;
        let coord: { x: number; y: number } | null = null;
        for (let i = 0; i < tries; i++) {
          if (ctx.signal?.aborted) return "已中止";
          coord = await tools.select(step.desc);
          if (coord) break;
          if (i < tries - 1) await sleep(1000);
        }
        if (!coord) return "vlm_select 定位失败: " + step.desc;
        await tools.click(coord.x, coord.y);
        return null;
      }
      case "vlm_check": {
        await sleep(step.settle ?? settleMs);
        let ans: boolean | null = null;
        for (let i = 0; i < 3; i++) {
          ans = await tools.check(step.ask, step.ref);
          if (ans !== null) break;
          if (i < 2) await sleep(1000);
        }
        vars[step.id] = ans ?? false;
        return null;
      }
      case "vlm_compare": {
        await sleep(step.settle ?? settleMs);
        let idx: number | null = null;
        for (let i = 0; i < 3; i++) {
          idx = await tools.compare(step.refs, step.ask);
          if (idx !== null) break;
          if (i < 2) await sleep(1000);
        }
        vars[step.id] = idx ?? 0;
        return null;
      }
      case "branch": {
        const cond = evalExpr(step.if, vars);
        const branchSteps = cond ? step.then : (step.else ?? []);
        for (const sub of branchSteps) {
          if (ctx.signal?.aborted) return "已中止";
          const err = await execStep(sub);
          if (err) return err;
        }
        return null;
      }
    }
  }

  try {
    for (let i = 0; i < recipe.steps.length; i++) {
      if (ctx.signal?.aborted) return { ok: false, error: "已中止", completed, total };
      const step = recipe.steps[i];
      ctx.onProgress?.({ index: i, total, desc: stepDesc(step) });
      const err = await execStep(step);
      if (err) return { ok: false, error: err, completed, total };
      completed = i + 1;
    }
    return { ok: true, completed, total };
  } catch (err) {
    if (err instanceof RecipeAbortError) {
      return { ok: false, error: "已中止", completed, total };
    }
    throw err;
  }
}
