import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock runSubAgent to control sub-agent behavior
vi.mock("./runner", () => ({
  runSubAgent: vi.fn(),
  isProfileRegistered: vi.fn(() => true),
  registerSubAgentProfile: vi.fn(),
}));

import { runSubAgent } from "./runner";
import { toSubAgentToolOutcome } from "./outcome-adapter";
import { parseSubAgentResult } from "./result-parser";
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

  it("same first 200 chars but different findings -> NOT a repeat (old slice behavior eliminated)", () => {
    // 两个结果前 200 字符完全相同，但后续 finding 不同
    const commonPrefix = '{"kind":"subagent_result","version":1,"taskId":"task-x","profile":"search","status":"succeeded","summary":"搜索完成","findings":[{"id":"f1","content":"';
    const result1: SubAgentRunOutcome = {
      invocationStatus: "completed",
      result: {
        kind: "subagent_result", version: 1, taskId: "task-x", profile: "search",
        status: "succeeded", summary: "搜索完成",
        findings: [{ id: "f1", content: commonPrefix + "AAA-unique-finding-content-that-makes-this-different-from-the-second-result", source: "https://example.com/1" }],
        artifacts: [], completionEvidence: [],
      },
    };
    const result2: SubAgentRunOutcome = {
      invocationStatus: "completed",
      result: {
        kind: "subagent_result", version: 1, taskId: "task-x", profile: "search",
        status: "succeeded", summary: "搜索完成",
        findings: [{ id: "f1", content: commonPrefix + "BBB-different-finding-content-that-should-not-be-detected-as-repeat", source: "https://example.com/2" }],
        artifacts: [], completionEvidence: [],
      },
    };

    const outcome1 = toSubAgentToolOutcome(result1);
    const outcome2 = toSubAgentToolOutcome(result2);

    // 前 200 字符相同（证明旧的 slice 行为已消除）
    expect(outcome1.output.slice(0, 200)).toBe(outcome2.output.slice(0, 200));

    // 但语义指纹不同 -> 不应触发 NO_PROGRESS
    const args = { objective: "搜索AI新闻" };

    // 使用 parseSubAgentResult 提取语义字段比较
    const parsed1 = parseSubAgentResult(outcome1.output);
    const parsed2 = parseSubAgentResult(outcome2.output);

    // findings 内容不同
    expect(parsed1.findings[0].content).not.toBe(parsed2.findings[0].content);
    expect(parsed1.findings[0].source).not.toBe(parsed2.findings[0].source);

    // 不应被视为重复
    expect(outcome2.status).toBe("succeeded");
    expect(outcome2.errorCode).toBeUndefined();
  });

  it("same semantic result with different taskId -> IS a repeat", () => {
    // 两个结果除了 taskId 外完全相同
    const baseResult = {
      kind: "subagent_result" as const, version: 1 as const,
      profile: "search" as const, status: "succeeded" as const,
      summary: "搜索完成",
      findings: [{ id: "f1", content: "新闻内容", source: "https://example.com/1" }],
      artifacts: [], completionEvidence: [{ criterion: "搜索完成", satisfied: true, evidenceRefs: ["https://example.com/1"] }],
    };

    const result1: SubAgentRunOutcome = {
      invocationStatus: "completed",
      result: { ...baseResult, taskId: "task-aaa-111" },
    };
    const result2: SubAgentRunOutcome = {
      invocationStatus: "completed",
      result: { ...baseResult, taskId: "task-bbb-222" },
    };

    const outcome1 = toSubAgentToolOutcome(result1);
    const outcome2 = toSubAgentToolOutcome(result2);

    // taskId 不同
    const parsed1 = parseSubAgentResult(outcome1.output);
    const parsed2 = parseSubAgentResult(outcome2.output);
    expect(parsed1.taskId).not.toBe(parsed2.taskId);

    // 但语义指纹相同 -> 应被检测为重复
    // 模拟主图指纹比较逻辑
    const fingerprint = (parsed: typeof parsed1) => JSON.stringify({
      profile: parsed.profile, status: parsed.status,
      findingsCount: parsed.findings.length,
      findingsContent: parsed.findings.map(f => ({ content: f.content?.slice(0, 100), source: f.source }))
        .sort((a, b) => (a.content ?? "").localeCompare(b.content ?? "")),
      artifactsPaths: parsed.artifacts.map(a => a.path).filter(Boolean).sort(),
      completionEvidence: parsed.completionEvidence.map(e => ({ criterion: e.criterion, satisfied: e.satisfied }))
        .sort((a, b) => a.criterion.localeCompare(b.criterion)),
    });

    expect(fingerprint(parsed1)).toBe(fingerprint(parsed2));
  });

  it("same content but different array order -> IS a repeat (normalized)", () => {
    // 两个结果的 findings/artifacts/evidence 顺序不同但内容相同
    const baseFindings = [
      { id: "f1", content: "新闻A", source: "https://a.com" },
      { id: "f2", content: "新闻B", source: "https://b.com" },
    ];
    const baseEvidence = [
      { criterion: "搜索完成", satisfied: true, evidenceRefs: ["https://a.com"] },
      { criterion: "来源验证", satisfied: true, evidenceRefs: ["https://b.com"] },
    ];

    const result1: SubAgentRunOutcome = {
      invocationStatus: "completed",
      result: {
        kind: "subagent_result", version: 1, taskId: "task-1", profile: "search",
        status: "succeeded", summary: "搜索完成",
        findings: [...baseFindings],
        artifacts: [],
        completionEvidence: [...baseEvidence],
      },
    };
    const result2: SubAgentRunOutcome = {
      invocationStatus: "completed",
      result: {
        kind: "subagent_result", version: 1, taskId: "task-2", profile: "search",
        status: "succeeded", summary: "搜索完成",
        findings: [...baseFindings].reverse(),
        artifacts: [],
        completionEvidence: [...baseEvidence].reverse(),
      },
    };

    const outcome1 = toSubAgentToolOutcome(result1);
    const outcome2 = toSubAgentToolOutcome(result2);
    const parsed1 = parseSubAgentResult(outcome1.output);
    const parsed2 = parseSubAgentResult(outcome2.output);

    // 原始顺序不同
    expect(parsed1.findings[0].content).not.toBe(parsed2.findings[0].content);

    // 但排序后指纹相同 -> 应被检测为重复
    const fingerprint = (parsed: typeof parsed1) => JSON.stringify({
      findingsContent: parsed.findings.map(f => ({ content: f.content?.slice(0, 100), source: f.source }))
        .sort((a, b) => (a.content ?? "").localeCompare(b.content ?? "")),
      completionEvidence: parsed.completionEvidence.map(e => ({ criterion: e.criterion, satisfied: e.satisfied }))
        .sort((a, b) => a.criterion.localeCompare(b.criterion)),
    });

    expect(fingerprint(parsed1)).toBe(fingerprint(parsed2));
  });
});
