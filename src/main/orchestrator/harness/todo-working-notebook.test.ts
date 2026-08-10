import { describe, expect, it } from "vitest";
import { TODO_WORKING_NOTEBOOK_POLICY } from "./todo-working-notebook";

describe("Todo mutable working notebook policy", () => {
  it("uses execution steps and tool rounds instead of LLM call count", () => {
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("至少 2 个 execution step");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("tool round");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("不按 LLM 调用次数");
  });

  it("keeps Todo mutable, optional for simple tasks, and non-binding", () => {
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("mutable working notebook");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("可变工作笔记");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("单次工具即可完成");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("不得作为后续行动的强约束");
    expect(TODO_WORKING_NOTEBOOK_POLICY).toContain("方向改变");
  });
});
