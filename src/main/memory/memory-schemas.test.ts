import { describe, expect, test } from "vitest";
import {
  parseMemoryJudgeResult,
  validateMemoryJudgeBusiness,
} from "./memory-schemas";

describe("Memory Judge structured output schema", () => {
  test("accepts the B-tier JSON Object envelope", () => {
    expect(parseMemoryJudgeResult({
      candidates: [{
        layer: "L1",
        content: "用户正在迁移 React Chat 窗口",
        confidence: 0.9,
        triggerText: "我正在前端 chat 窗口迁移 react",
      }],
    })).toEqual([{
      layer: "L1",
      content: "用户正在迁移 React Chat 窗口",
      confidence: 0.9,
      triggerText: "我正在前端 chat 窗口迁移 react",
    }]);
  });

  test("treats an empty candidates envelope as a successful no-op", () => {
    const candidates = parseMemoryJudgeResult({ candidates: [] });

    expect(validateMemoryJudgeBusiness(candidates)).toEqual({
      status: "accepted",
      value: [],
    });
  });
});
