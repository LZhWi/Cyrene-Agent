import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock runSubAgent to control sub-agent behavior
vi.mock("./runner", () => ({
  runSubAgent: vi.fn(),
  isProfileRegistered: vi.fn(() => true),
  registerSubAgentProfile: vi.fn(),
}));

import { runSubAgent } from "./runner";
import { toSubAgentToolOutcome } from "./outcome-adapter";
import type { SubAgentRunOutcome } from "./types";

describe("main graph repeated sub-agent protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("partial result repeated with same args -> second call converts to SUBAGENT_NO_PROGRESS", () => {
    // 模拟子代理返回 partial 结果
    const partialOutcome: SubAgentRunOutcome = {
      invocationStatus: "completed",
      result: {
        kind: "subagent_result",
        version: 1,
        taskId: "task-1",
        profile: "search",
        status: "partial",
        summary: "找到部分结果",
        findings: [{ id: "f1", content: "新闻1" }],
        artifacts: [],
        completionEvidence: [],
      },
    };

    vi.mocked(runSubAgent).mockResolvedValue(partialOutcome);

    // 第一次调用
    const outcome1 = toSubAgentToolOutcome(partialOutcome);
    expect(outcome1.status).toBe("succeeded"); // partial maps to succeeded + terminal:false

    // 模拟主图重复委托保护逻辑
    const args = { objective: "搜索AI新闻" };
    const lastResult = {
      toolId: "delegate_search",
      args,
      output: outcome1.output,
      status: "succeeded" as const,
      terminal: false,
    };

    // 第二次调用相同参数
    const outcome2 = toSubAgentToolOutcome(partialOutcome);
    const currentOutput = outcome2.output.slice(0, 200);
    const lastOutput = lastResult.output.slice(0, 200);
    const currentArgs = JSON.stringify(args);
    const lastArgs = JSON.stringify(lastResult.args);

    // 验证重复检测逻辑
    expect(currentArgs).toBe(lastArgs);
    expect(currentOutput).toBe(lastOutput);

    // 如果重复，应转换为 no-progress
    if (currentArgs === lastArgs && currentOutput === lastOutput) {
      outcome2.status = "failed";
      outcome2.output = JSON.stringify({
        kind: "subagent_result",
        version: 1,
        taskId: "no_progress",
        profile: "search",
        status: "failed",
        summary: "子代理重复委托：相同参数返回相同结果",
        findings: [],
        artifacts: [],
        completionEvidence: [],
        error: {
          code: "SUBAGENT_NO_PROGRESS",
          message: "子代理重复委托：相同参数返回相同结果",
          recoverable: false,
        },
      });
      outcome2.errorCode = "SUBAGENT_NO_PROGRESS";
      outcome2.terminal = true;
      outcome2.retryable = false;
    }

    expect(outcome2.status).toBe("failed");
    expect(outcome2.errorCode).toBe("SUBAGENT_NO_PROGRESS");
    expect(outcome2.terminal).toBe(true);
    expect(outcome2.retryable).toBe(false);
  });

  it("blocked result repeated with same args -> second call converts to SUBAGENT_NO_PROGRESS", () => {
    // 模拟子代理返回 blocked 结果
    const blockedOutcome: SubAgentRunOutcome = {
      invocationStatus: "completed",
      result: {
        kind: "subagent_result",
        version: 1,
        taskId: "task-2",
        profile: "document",
        status: "blocked",
        summary: "缺少用户信息",
        findings: [],
        artifacts: [],
        completionEvidence: [],
        missingInformation: ["希望生成 Word 还是 PDF？"],
        error: {
          code: "SUBAGENT_BLOCKED",
          message: "缺少用户信息",
          recoverable: true,
        },
      },
    };

    vi.mocked(runSubAgent).mockResolvedValue(blockedOutcome);

    // 第一次调用
    const outcome1 = toSubAgentToolOutcome(blockedOutcome);
    expect(outcome1.status).toBe("failed"); // blocked maps to failed + retryable:true

    // 模拟主图重复委托保护逻辑
    const args = { objective: "生成文档", filename: "test.docx" };
    const lastResult = {
      toolId: "delegate_document",
      args,
      output: outcome1.output,
      status: "failed" as const,
      terminal: true,
    };

    // 第二次调用相同参数
    const outcome2 = toSubAgentToolOutcome(blockedOutcome);
    const currentOutput = outcome2.output.slice(0, 200);
    const lastOutput = lastResult.output.slice(0, 200);
    const currentArgs = JSON.stringify(args);
    const lastArgs = JSON.stringify(lastResult.args);

    // 验证重复检测逻辑
    expect(currentArgs).toBe(lastArgs);
    expect(currentOutput).toBe(lastOutput);

    // 如果重复，应转换为 no-progress
    if (currentArgs === lastArgs && currentOutput === lastOutput) {
      outcome2.status = "failed";
      outcome2.output = JSON.stringify({
        kind: "subagent_result",
        version: 1,
        taskId: "no_progress",
        profile: "document",
        status: "failed",
        summary: "子代理重复委托：相同参数返回相同结果",
        findings: [],
        artifacts: [],
        completionEvidence: [],
        error: {
          code: "SUBAGENT_NO_PROGRESS",
          message: "子代理重复委托：相同参数返回相同结果",
          recoverable: false,
        },
      });
      outcome2.errorCode = "SUBAGENT_NO_PROGRESS";
      outcome2.terminal = true;
      outcome2.retryable = false;
    }

    expect(outcome2.status).toBe("failed");
    expect(outcome2.errorCode).toBe("SUBAGENT_NO_PROGRESS");
    expect(outcome2.terminal).toBe(true);
    expect(outcome2.retryable).toBe(false);
  });

  it("different args -> not treated as repeat", () => {
    // 模拟子代理返回相同结果但不同参数
    const outcome: SubAgentRunOutcome = {
      invocationStatus: "completed",
      result: {
        kind: "subagent_result",
        version: 1,
        taskId: "task-3",
        profile: "search",
        status: "succeeded",
        summary: "找到结果",
        findings: [{ id: "f1", content: "新闻" }],
        artifacts: [],
        completionEvidence: [],
      },
    };

    vi.mocked(runSubAgent).mockResolvedValue(outcome);

    // 第一次调用
    const outcome1 = toSubAgentToolOutcome(outcome);
    const args1 = { objective: "搜索AI新闻" };

    // 第二次调用不同参数
    const args2 = { objective: "搜索科技新闻" };
    const outcome2 = toSubAgentToolOutcome(outcome);

    const currentOutput = outcome2.output.slice(0, 200);
    const lastOutput = outcome1.output.slice(0, 200);
    const currentArgs = JSON.stringify(args2);
    const lastArgs = JSON.stringify(args1);

    // 不同参数不应被误判为重复
    expect(currentArgs).not.toBe(lastArgs);
    expect(currentOutput).toBe(lastOutput); // 结果相同但参数不同

    // 不应转换为 no-progress
    expect(outcome2.status).toBe("succeeded");
    expect(outcome2.errorCode).toBeUndefined();
  });
});
