// loadVisionConfig 与旧配置迁移的回归测试：
// 主模型走 Anthropic 协议时视觉链路拼 /chat/completions 必然 404，
// 必须改用独立视觉模型；老配置里已配好的独立视觉模型不能被 multimodal 默认值静默旁路。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cyrene-test" } }));

import { loadVisionConfig, normalizeModelSettings, type ModelSettings, type VisionModelConfig } from "./model-settings";

// 旧版 vision 配置带 syncWithMain 标记（迁移用），比 VisionModelConfig 多一个可选字段
type LegacyVision = VisionModelConfig & { syncWithMain?: boolean };

const MINIMAX_BASE = {
  provider: "MiniMax（稀宇科技）",
  baseUrl: "https://api.minimaxi.com/anthropic",
  model: "MiniMax-M3",
  apiKey: "sk-test",
  explicitTransport: "anthropic",
} as const;

const COMPLETE_VISION: LegacyVision = {
  baseUrl: "https://api.minimaxi.com/v1",
  apiKey: "sk-vision",
  model: "MiniMax-M3",
};

function makeSettings(overrides: Record<string, unknown> = {}): ModelSettings {
  return normalizeModelSettings({ ...MINIMAX_BASE, ...overrides });
}

describe("loadVisionConfig 独立视觉任务后端", () => {
  it("聊天图片直发 + 独立视觉后端 → 视觉任务使用独立 VLM", () => {
    const s = makeSettings({ multimodal: true, visionBackend: "independent", vision: COMPLETE_VISION });
    const cfg = loadVisionConfig(s);
    expect(cfg?.baseUrl).toBe("https://api.minimaxi.com/v1");
    expect(cfg?.apiKey).toBe("sk-vision");
  });

  it("聊天图片直发 + 主模型视觉后端 → 视觉任务使用主模型", () => {
    const s = makeSettings({
      multimodal: true,
      visionBackend: "main",
      vision: { baseUrl: "https://api.minimaxi.com/v1", apiKey: "", model: "MiniMax-M3" },
    });
    const cfg = loadVisionConfig(s);
    expect(cfg?.baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(cfg?.apiKey).toBe("sk-test");
  });

  it("聊天图片转述 + 主模型视觉后端 → 转述仍可使用主模型", () => {
    const s = makeSettings({
      provider: "Kimi（月之暗面）",
      baseUrl: "https://api.moonshot.cn/v1",
      explicitTransport: "openai",
      multimodal: false,
      visionBackend: "main",
      vision: COMPLETE_VISION,
    });
    expect(loadVisionConfig(s)?.baseUrl).toBe("https://api.moonshot.cn/v1");
  });

  it("聊天图片转述 + 独立视觉后端 → 使用独立 VLM", () => {
    const s = makeSettings({ multimodal: false, visionBackend: "independent", vision: COMPLETE_VISION });
    expect(loadVisionConfig(s)?.baseUrl).toBe("https://api.minimaxi.com/v1");
  });

  it("选择独立 VLM 但配置不完整 → null（不静默换回主模型）", () => {
    const s = makeSettings({
      multimodal: true,
      visionBackend: "independent",
      vision: { baseUrl: "https://api.minimaxi.com/v1", apiKey: "", model: "MiniMax-M3" },
    });
    expect(loadVisionConfig(s)).toBeNull();
  });
});

describe("normalizeModelSettings 旧配置迁移", () => {
  it("旧配置无 multimodal 字段 + 独立视觉模型齐全 → multimodal 落 false（不静默旁路）", () => {
    const s = normalizeModelSettings({ ...MINIMAX_BASE, vision: COMPLETE_VISION });
    expect(s.multimodal).toBe(false);
    expect(s.visionBackend).toBe("independent");
    expect(loadVisionConfig(s)?.baseUrl).toBe("https://api.minimaxi.com/v1");
  });

  it("旧配置 syncWithMain=true → multimodal 落 true（与主模型同步）", () => {
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      vision: { ...COMPLETE_VISION, syncWithMain: true },
    });
    expect(s.multimodal).toBe(true);
    expect(s.visionBackend).toBe("independent");
  });

  it("旧配置无视觉模型 → multimodal 维持默认 true", () => {
    const s = normalizeModelSettings({ ...MINIMAX_BASE });
    expect(s.multimodal).toBe(true);
    expect(s.visionBackend).toBe("main");
  });

  it("multimodal 已持久化 → 不被迁移翻转（用户显式选择优先）", () => {
    const s = normalizeModelSettings({ ...MINIMAX_BASE, multimodal: true, vision: COMPLETE_VISION });
    expect(s.multimodal).toBe(true);
    expect(s.visionBackend).toBe("independent");
  });

  it("旧配置视觉模型不齐全 → multimodal 维持默认 true", () => {
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      vision: { baseUrl: "https://api.minimaxi.com/v1", apiKey: "", model: "MiniMax-M3" },
    });
    expect(s.multimodal).toBe(true);
    expect(s.visionBackend).toBe("main");
  });

  it("显式视觉后端优先于旧版自动路由", () => {
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      multimodal: true,
      visionBackend: "main",
      vision: COMPLETE_VISION,
    });
    expect(s.visionBackend).toBe("main");
    expect(loadVisionConfig(s)?.baseUrl).toBe("https://api.minimaxi.com/anthropic");
  });

  it("跟随主模型时按本轮指定档案解析，而不是误用默认档案", () => {
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      visionBackend: "main",
      modelProfiles: [
        { id: "default", provider: "A", baseUrl: "https://a.example/v1", apiKey: "a", model: "vision-a" },
        { id: "bound", provider: "B", baseUrl: "https://b.example/v1", apiKey: "b", model: "vision-b" },
      ],
      defaultModelProfileId: "default",
    });

    expect(loadVisionConfig(s, "bound")).toEqual({
      baseUrl: "https://b.example/v1",
      apiKey: "b",
      model: "vision-b",
    });
  });
});
