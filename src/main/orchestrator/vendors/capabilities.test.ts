import { describe, expect, test } from "vitest";
import { PROVIDER_CAPABILITIES, getCapability } from "./capabilities";

describe("PROVIDER_CAPABILITIES — MiMo（小米）", () => {
  test("MiMo 条目存在", () => {
    const mimo = getCapability("MiMo（小米）");
    expect(mimo).toBeDefined();
    expect(mimo?.id).toBe("mimo");
  });

  test("MiMo displayName 字段正确", () => {
    const mimo = getCapability("MiMo（小米）");
    expect(mimo?.displayName).toBe("MiMo（小米）");
  });

  test("MiMo 字段齐全（id, displayName, transport, baseUrl, authStyle, defaultModel, supportsVision, visionBaseUrl）", () => {
    const mimo = getCapability("MiMo（小米）");
    expect(mimo).toMatchObject({
      id: "mimo",
      displayName: "MiMo（小米）",
      transport: "openai",
      baseUrl: "https://api.xiaomimimo.com/v1",
      authStyle: "bearer",
      defaultModel: "mimo-v2.5-pro",
      supportsVision: true,
      visionBaseUrl: "https://api.xiaomimimo.com/v1",
    });
  });

  test("PROVIDER_CAPABILITIES 中确实包含 MiMo", () => {
    const found = PROVIDER_CAPABILITIES.find((c) => c.displayName === "MiMo（小米）");
    expect(found).toBeDefined();
  });
});

describe("PROVIDER_CAPABILITIES — 回归", () => {
  test("现有 8 家 displayName 都存在", () => {
    const names = PROVIDER_CAPABILITIES.map((c) => c.displayName);
    expect(names).toEqual(
      expect.arrayContaining([
        "MiniMax（稀宇科技）",
        "DeepSeek（深度求索）",
        "火山 AgentPlan（火山引擎）",
        "GLM（智谱）",
        "Kimi（月之暗面）",
        "Qwen（通义千问）",
        "ChatGPT（OpenAI）",
        "Claude（Anthropic）",
        "MiMo（小米）",
      ]),
    );
  });

  test("每条 capability 都有合法 authStyle", () => {
    for (const cap of PROVIDER_CAPABILITIES) {
      expect(["bearer", "x-api-key"]).toContain(cap.authStyle);
    }
  });
});