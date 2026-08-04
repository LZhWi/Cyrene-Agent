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

/** 快照所有工具的 enabled 状态。 */
function snapshotEnabled(): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const tool of toolRegistry.getAllTools()) {
    map.set(tool.id, tool.enabled);
  }
  return map;
}

/** 断言所有工具的 enabled 与快照一致。 */
function assertEnabledUnchanged(before: Map<string, boolean>, label: string) {
  for (const tool of toolRegistry.getAllTools()) {
    expect(tool.enabled, `tool "${tool.id}" enabled was mutated ${label}`).toBe(before.get(tool.id));
  }
}

describe("SubAgent concurrency isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDelegateSettings(() => ({
      provider: "openai",
      baseUrl: "https://test",
      model: "test-model",
      apiKey: "test-key",
      contextWindowTokens: 256000,
    }));
    // 确保测试所需工具已注册（全局单例，register 幂等）
    for (const id of ["delegate_task", "ask_user_choice", "web_search"]) {
      if (!toolRegistry.getById(id)) {
        toolRegistry.register(testTool(id));
      }
    }
  });

  it("does not mutate global toolRegistry enabled flags while sub-agent is still running", async () => {
    const before = snapshotEnabled();

    // 用可控 Promise 模拟子代理运行中（不立即 resolve）
    let resolveFn!: () => void;
    vi.mocked(runFunctionCallingLoop).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFn = () => resolve({ reply: "任务完成", toolResults: [] });
        }),
    );

    // 启动子代理但不 await——此时 runFunctionCallingLoop 正挂起
    const subAgentPromise = runSubAgent("测试任务");

    // 子代理仍在运行期间，断言全局 registry 未被修改
    assertEnabledUnchanged(before, "during execution (sub-agent pending)");

    // resolve 并完成
    resolveFn();
    await subAgentPromise;

    // 完成后再次断言
    assertEnabledUnchanged(before, "after execution (sub-agent resolved)");
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
