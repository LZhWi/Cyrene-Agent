// script-parser 单测 —— YAML 文本 → GameRecipe 解析 + 校验。
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseRecipe } from "./script-parser";

describe("parseRecipe", () => {
  it("解析合法完整脚本（含所有原语 + branch 嵌套）", () => {
    const yaml = [
      'name: star-rail-daily',
      'exe: "${exe_path}"',
      'model: "${vlm_config}"',
      'steps:',
      '  - launch: "${exe}"',
      '  - wait: 60s',
      '  - key: F4',
      '  - click: center',
      '  - vlm_click: { ref: download_btn, repeat: 3, interval: 1s }',
      '  - vlm_select: "支援列表第一个"',
      '  - vlm_check: { id: has_update, ask: "有更新弹窗吗？" }',
      '  - vlm_compare: { id: st, ask: "匹配哪个", refs: [a, b] }',
      '  - branch:',
      '      if: "${has_update}"',
      '      then:',
      '        - click: center',
      '      else:',
      '        - key: ESC',
    ].join("\n");
    const r = parseRecipe(yaml);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.name).toBe("star-rail-daily");
    expect(r.recipe.steps).toHaveLength(9);
    expect(r.recipe.steps[0]).toEqual({ type: "launch", exe: "${exe}" });
    expect(r.recipe.steps[1]).toEqual({ type: "wait", ms: 60000 });
    expect(r.recipe.steps[2]).toEqual({ type: "key", combo: "F4" });
    expect(r.recipe.steps[3]).toEqual({ type: "click", target: "center" });
    expect(r.recipe.steps[4]).toEqual({
      type: "vlm_click", ref: "download_btn", repeat: 3, interval: 1000, retry: 2,
    });
    expect(r.recipe.steps[5]).toEqual({
      type: "vlm_select", desc: "支援列表第一个", retry: 2,
    });
    expect(r.recipe.steps[6]).toEqual({
      type: "vlm_check", id: "has_update", ask: "有更新弹窗吗？",
    });
    expect(r.recipe.steps[7]).toEqual({
      type: "vlm_compare", id: "st", ask: "匹配哪个", refs: ["a", "b"],
    });
    const br = r.recipe.steps[8];
    expect(br.type).toBe("branch");
    if (br.type === "branch") {
      expect(br.if).toBe("${has_update}");
      expect(br.then).toEqual([{ type: "click", target: "center" }]);
      expect(br.else).toEqual([{ type: "key", combo: "ESC" }]);
    }
  });

  it("缺 name 报错", () => {
    const r = parseRecipe("exe: x\nsteps: []");
    expect(r.ok).toBe(false);
  });

  it("缺 steps 报错", () => {
    const r = parseRecipe("name: x\nexe: y");
    expect(r.ok).toBe(false);
  });

  it("未知原语报错", () => {
    const r = parseRecipe("name: x\nexe: y\nsteps:\n  - unknown_op: foo");
    expect(r.ok).toBe(false);
  });

  it("wait 纯数字当 ms", () => {
    const r = parseRecipe("name: x\nexe: y\nsteps:\n  - wait: 500");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.steps[0]).toEqual({ type: "wait", ms: 500 });
  });

  it("wait ms 单位", () => {
    const r = parseRecipe("name: x\nexe: y\nsteps:\n  - wait: 250ms");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.steps[0]).toEqual({ type: "wait", ms: 250 });
  });

  it("click 坐标形式", () => {
    const r = parseRecipe("name: x\nexe: y\nsteps:\n  - click: { x: 100, y: 200 }");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recipe.steps[0]).toEqual({ type: "click", target: { x: 100, y: 200 } });
  });

  it("vlm_check 缺 id 报错", () => {
    const r = parseRecipe('name: x\nexe: y\nsteps:\n  - vlm_check: { ask: "有吗" }');
    expect(r.ok).toBe(false);
  });

  it("非法 YAML 报错", () => {
    const r = parseRecipe("name: x\n  bad: : :");
    expect(r.ok).toBe(false);
  });

  it("解析货币战争专用 runner", () => {
    const r = parseRecipe('name: cw\nexe: game.exe\nrunner: currency-wars\nsteps: []');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe.runner).toBe("currency-wars");
  });

  it("内置货币战争配方使用用户配置的游戏路径", () => {
    const yaml = fs.readFileSync(path.join(process.cwd(), "game-recipes", "star-rail-currency-wars.yaml"), "utf8");
    const r = parseRecipe(yaml);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe.exe).toBe("${exe_path}");
  });
});
