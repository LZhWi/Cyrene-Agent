import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock 重依赖模块，保留 toolRegistry 真实单例
vi.mock("./vendors", () => ({
  getAdapter: vi.fn(),
}));

vi.mock("../permission", () => ({
  checkPermission: vi.fn(async () => ({ allowed: true })),
}));

vi.mock("../token-usage-store", () => ({
  recordUsage: vi.fn(),
}));

vi.mock("../skills/skill-tools", () => ({
  resetReadRefs: vi.fn(),
}));

vi.mock("./context-manager", () => ({
  truncateToolResult: vi.fn((s: string) => s),
  compressConversation: vi.fn(async (opts: { messages: unknown[] }) => opts.messages),
}));

vi.mock("../timeout-manager", () => ({
  getTimeoutSettings: vi.fn(() => ({
  })),
}));

import { getAdapter } from "./vendors";
import { runFunctionCallingLoop } from "./function-calling";
import { toolRegistry } from "./tool-registry";

/** 测试用唯一 ID，避免与其他测试文件注册的工具冲突。 */
const BLOCKED_TOOL_ID = "test_fc_blocked_tool";
const ALLOWED_TOOL_ID = "test_fc_allowed_tool";

describe("runFunctionCallingLoop allowedToolIds guard", () => {
  const blockedSpy = vi.fn(async () => "should not be called");
  let originalFetch: typeof globalThis.fetch;

  const mockAdapter = {
    transport: "test",
    buildRequest: vi.fn(() => ({
      url: "https://test/api",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })),
    parseResponse: vi.fn(),
    appendToolResults: vi.fn(
      (conv: unknown[], results: Array<{ output: string }>) => [
        ...conv,
        ...results.map(r => ({ role: "tool" as const, content: r.output })),
      ],
    ),
    applyCacheHints: undefined as unknown,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;

    // 注册测试工具
    toolRegistry.register({
      id: BLOCKED_TOOL_ID,
      name: "Blocked Test Tool",
      description: "test",
      enabled: true,
      inputSchema: { type: "object", properties: {} },
      execute: blockedSpy,
    });
    toolRegistry.register({
      id: ALLOWED_TOOL_ID,
      name: "Allowed Test Tool",
      description: "test",
      enabled: true,
      inputSchema: { type: "object", properties: {} },
      execute: async () => "allowed",
    });

    vi.mocked(getAdapter).mockReturnValue(mockAdapter as never);

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
      text: async () => "",
    })) as never;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("blocks hallucinated tool calls outside allowedToolIds without executing them", async () => {
    // 第一轮：模型幻觉调用不在白名单内的工具
    // 第二轮：模型返回文本，循环正常结束
    mockAdapter.parseResponse
      .mockReturnValueOnce({
        text: "",
        toolCalls: [{ name: BLOCKED_TOOL_ID, arguments: "{}", id: "tc_1" }],
        assistantMessage: { role: "assistant" as const, content: "" },
        usage: undefined,
        finishReason: "tool_calls",
        thinking: undefined,
      })
      .mockReturnValueOnce({
        text: "done",
        toolCalls: [],
        assistantMessage: { role: "assistant" as const, content: "done" },
        usage: undefined,
        finishReason: "stop",
        thinking: undefined,
      });

    const result = await runFunctionCallingLoop(
      { provider: "openai", baseUrl: "https://test", model: "test", apiKey: "key", contextWindowTokens: 256000 },
      [{ role: "user", content: "test" }],
      60000,
      [ALLOWED_TOOL_ID], // 白名单不包含 BLOCKED_TOOL_ID
    );

    // 被屏蔽工具的 execute 从未被调用
    expect(blockedSpy).not.toHaveBeenCalled();

    // 工具结果标记为不可用
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].toolId).toBe(BLOCKED_TOOL_ID);
    expect(result.toolResults[0].status).toBe("failed");
    expect(result.toolResults[0].errorCode).toBe("E_TOOL_UNAVAILABLE");
  });
});
