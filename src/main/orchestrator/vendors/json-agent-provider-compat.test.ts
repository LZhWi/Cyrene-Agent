import { describe, expect, test } from "vitest";
import { buildActionGateRequest } from "../action-gate";
import { getAdapterForConfig, getCapability } from "./index";

describe.each([
  ["MiniMax（稀宇科技）", "MiniMax-M3"],
  ["Kimi（月之暗面）", "kimi-k2.7-code"],
  ["DeepSeek（深度求索）", "deepseek-v4-pro"],
] as const)("JSON Agent protocol on %s", (provider, model) => {
  test("does not emit tools or tool_choice when reasoning is enabled", () => {
    const capability = getCapability(provider)!;
    const cfg = {
      provider,
      baseUrl: capability.baseUrl,
      model,
      apiKey: "test-key",
      explicitTransport: "openai" as const,
      reasoning: { mode: "on" as const, effort: "medium" as const },
    };
    const adapter = getAdapterForConfig(cfg);
    const request = buildActionGateRequest({
      model,
      originalQuery: "播放第一首",
      contextualizedQuery: "播放候选中的第一首",
      citaContextBlock: "[CITA_CONTEXT]candidateRef=music-candidate-1[/CITA_CONTEXT]",
      messages: [{ role: "user", content: "播放第一首" }],
      availableCapabilities: [{ capability: "music.play_track", toolId: "music_play_track", description: "播放歌曲" }],
      toolResults: [],
    });
    const body = JSON.parse(adapter.buildRequest(request, cfg).body) as Record<string, unknown>;

    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});
