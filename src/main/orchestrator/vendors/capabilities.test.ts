import { describe, expect, test } from "vitest";
import { PROVIDER_CAPABILITIES, getCapability } from "./capabilities";

describe("PROVIDER_CAPABILITIES — schema smoke", () => {
  test("每条 capability 都有 id 与 displayName，且非空", () => {
    for (const cap of PROVIDER_CAPABILITIES) {
      expect(cap.id, `entry missing id`).toBeTruthy();
      expect(cap.displayName, `entry ${cap.id} missing displayName`).toBeTruthy();
    }
  });

  test("id 唯一（不允许两条 capability 共享同一 id）", () => {
    const ids = PROVIDER_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("displayName 唯一（不允许两条 capability 共享同一显示名）", () => {
    const names = PROVIDER_CAPABILITIES.map((c) => c.displayName);
    expect(new Set(names).size).toBe(names.length);
  });

  test("MiMo（小米）条目存在且关键字段齐全", () => {
    const mimo = getCapability("MiMo（小米）");
    expect(mimo).toBeDefined();
    expect(mimo?.id).toBe("mimo");
    expect(mimo?.displayName).toBe("MiMo（小米）");
  });
});

describe("PROVIDER_CAPABILITIES — 已知条目存在性回归", () => {
  test("9 家 provider 的 displayName 都在表中", () => {
    const names = new Set(PROVIDER_CAPABILITIES.map((c) => c.displayName));
    for (const expected of [
      "MiniMax（稀宇科技）",
      "DeepSeek（深度求索）",
      "火山 AgentPlan（火山引擎）",
      "GLM（智谱）",
      "Kimi（月之暗面）",
      "Qwen（通义千问）",
      "ChatGPT（OpenAI）",
      "Claude（Anthropic）",
      "MiMo（小米）",
    ]) {
      expect(names.has(expected), `missing displayName: ${expected}`).toBe(true);
    }
  });
});