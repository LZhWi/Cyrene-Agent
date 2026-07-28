import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock runFunctionCallingLoop 避免真实 HTTP 调用
vi.mock("./function-calling", () => ({
  runFunctionCallingLoop: vi.fn(),
}));

import { runFunctionCallingLoop } from "./function-calling";
import { runSubAgent, setDelegateSettings } from "./sub-agent";
import { toolRegistry } from "./tool-registry";

/** 测试用的最小工具定义。 */
function testTool(id: string) {
  return {
    id,
    name: id,
    description: "test tool",
    enabled: true,
    inputSchema: { type: "object" as const, properties: {} },
    execute: async () => "test",
  };
}

describe("SubAgent concurrency isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDelegateSettings(() => ({
      provider: "openai",
      baseUrl: "https://test",
      model: "test-model",
      apiKey: "test-key",
    }));
    // 确保测试所需工具已注册（全局单例，register 幂等）
    for (const id of ["delegate_task", "ask_user_choice", "web_search"]) {
      if (!toolRegistry.getById(id)) {
        toolRegistry.register(testTool(id));
      }
    }
  });

  it("does not mutate global toolRegistry enabled flags during execution", async () => {
    // 快照所有工具的 enabled 状态
    const before = new Map<string, boolean>();
    for (const tool of toolRegistry.getAllTools()) {
      before.set(tool.id, tool.enabled);
    }

    vi.mocked(runFunctionCallingLoop).mockResolvedValue({
      reply: "任务完成",
      toolResults: [],
    });

    await runSubAgent("测试任务");

    // 断言：没有任何工具的 enabled 标志被修改
    for (const tool of toolRegistry.getAllTools()) {
      expect(tool.enabled, `tool "${tool.id}" enabled was mutated`).toBe(before.get(tool.id));
    }
  });

  it("passes allowedToolIds excluding delegate_task and ask_user_choice", async () => {
    vi.mocked(runFunctionCallingLoop).mockResolvedValue({
      reply: "任务完成",
      toolResults: [],
    });

    await runSubAgent("测试任务");

    const callArgs = vi.mocked(runFunctionCallingLoop).mock.calls[0];
    const allowedToolIds = callArgs?.[3] as string[] | undefined;

    expect(allowedToolIds).toBeDefined();
    expect(allowedToolIds).not.toContain("delegate_task");
    expect(allowedToolIds).not.toContain("ask_user_choice");
    // 确保非屏蔽工具仍在白名单中
    expect(allowedToolIds).toContain("web_search");
  });
});
