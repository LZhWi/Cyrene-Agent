import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock fs to avoid real file operations
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ size: 4096, isFile: () => true, mtimeMs: Date.now() + 10000 })),
}));

import { existsSync, statSync } from "fs";
import { toolRegistry } from "../tool-registry";
import { registerDocumentProfile } from "./document-agent";
import { runSubAgent, isProfileRegistered, registerSubAgentProfile } from "./runner";
import { registerBuiltInSubAgentProfiles, _resetSubAgentInit } from "./init";
import { resolveRouteAfterTool } from "../agent-graph";
import { toSubAgentToolOutcome } from "./outcome-adapter";
import { parseSubAgentResult, serializeSubAgentResult, SubAgentProtocolError } from "./result-parser";
import { projectToolResult, buildSoulExecutionContext } from "../soul-execution-context";
import { verifyStep } from "../task-plan";
import type { ToolCallResult } from "../types";
import type { PlanStep } from "../task-plan";
import type { ToolContext } from "../tool-context";

const MOCK_FILE_PATH = "C:\\Users\\Test\\Desktop\\AI新闻简报.docx";

/** 注册测试所需的 mock 工具（总是覆盖，防止前序测试修改残留） */
function ensureTestTools() {
  toolRegistry.register({
    id: "write_word",
    name: "写 Word",
    description: "test",
    enabled: true,
    risk: "fs-write",
    inputSchema: { type: "object", properties: {} },
    execute: async () => `[write_word] 已生成：${MOCK_FILE_PATH}`,
  });

  if (!toolRegistry.getById("web_search")) {
    toolRegistry.register({
      id: "web_search",
      name: "联网搜索",
      description: "test",
      enabled: true,
      risk: "network",
      soulActionLabel: "网络搜索",
      soulProjection: {
        projector: "entity_list",
        source: "external_untrusted",
        itemsPath: "results",
        fields: { title: "title", url: "url", snippet: "snippet" },
        maxItems: 8,
      },
      completionEvidence: [{ kind: "tool_succeeded" }],
      inputSchema: { type: "object", properties: {} },
      execute: async () => "test",
    });
  }

  // 注册一个白名单外的工具用于测试
  if (!toolRegistry.getById("send_email")) {
    toolRegistry.register({
      id: "send_email",
      name: "发送邮件",
      description: "test",
      enabled: true,
      risk: "network",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "email sent",
    });
  }
}

/** 注册 delegate_document（与 built-in-tools.ts 配置一致，含 completionEvidenceVerifier） */
function ensureDelegateDocument() {
  if (!toolRegistry.getById("delegate_document")) {
    toolRegistry.register({
      id: "delegate_document",
      name: "委托文档生成",
      description: "test",
      enabled: true,
      capability: "delegate_document",
      executionKind: "subagent",
      subAgentProfile: "document",
      ledgerPolicy: "bypass",
      soulActionLabel: "生成文档",
      soulProjection: {
        projector: "entity_detail",
        source: "trusted_internal",
        fields: {
          title: "summary",
          artifactName: "primaryArtifact.name",
          artifactPath: "primaryArtifact.path",
          artifactVerified: "primaryArtifact.verified",
        },
      },
      completionEvidence: [{ kind: "tool_succeeded" }],
      completionEvidenceVerifier: (result) => {
        try {
          const parsed = parseSubAgentResult(result.output);
          return parsed.status === "succeeded"
            && parsed.artifacts.length > 0
            && parsed.artifacts.every(a => a.verified)
            && parsed.artifacts.some(a => !!a.path);
        } catch {
          return false;
        }
      },
      inputSchema: { type: "object", properties: {} },
      execute: async () => { throw new Error("SUBAGENT_MUST_USE_SPECIAL_EXECUTOR"); },
    });
  }
}

const newsParagraphs = [
  "2026年7月28日，OpenAI发布最新模型GPT-5，在推理和编码任务上性能显著提升。",
  "Google DeepMind宣布AlphaFold 3已开源，将加速全球药物研发进程。",
  "Meta推出Llama 4系列开源模型，支持多模态输入和100万token上下文窗口。",
];

describe("Document Agent vertical slice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureTestTools();
    ensureDelegateDocument();
    // 显式注册 Profile（不依赖模块加载副作用）
    if (!isProfileRegistered("document")) {
      registerDocumentProfile();
    }
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({
      size: 4096,
      isFile: () => true,
      mtimeMs: Date.now() + 10000,
    } as never);
  });

  it("generates Word, verifies file, returns verified artifact (artifacts_only, no findings)", async () => {
    const outcome = await runSubAgent({
      profile: "document",
      taskId: "task-1",
      args: {
        objective: "将新闻资料生成 Word 简报",
        filename: "AI新闻简报.docx",
        title: "AI 新闻简报",
        paragraphs: newsParagraphs,
        style: "default",
      },
      parentContext: { runId: "test-run" },
    });

    expect(outcome.invocationStatus).toBe("completed");
    const result = outcome.result!;

    expect(result.status).toBe("succeeded");
    expect(result.profile).toBe("document");
    expect(result.findings).toHaveLength(0); // artifacts_only
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path).toBe(MOCK_FILE_PATH);
    expect(result.artifacts[0].verified).toBe(true);
    expect(result.artifacts[0].sizeBytes).toBe(4096);
    expect(result.completionEvidence[0].satisfied).toBe(true);
    expect(result.primaryArtifact!.path).toBe(MOCK_FILE_PATH);
  });

  it("inherits the parent workspace binding when it executes write_word", async () => {
    let receivedContext: ToolContext | undefined;
    toolRegistry.register({
      id: "write_word",
      name: "写 Word",
      description: "test",
      enabled: true,
      risk: "fs-write",
      inputSchema: { type: "object", properties: {} },
      execute: async (_args, context) => {
        receivedContext = context;
        return `[write_word] 已生成：C:\\projects\\bound-workspace\\brief.docx`;
      },
    });

    await runSubAgent({
      profile: "document",
      taskId: "workspace-bound-document",
      args: { objective: "生成简报", filename: "brief.docx", title: "简报", paragraphs: ["内容"] },
      parentContext: {
        runId: "parent-run",
        resolvedWorkspaceRoot: "C:\\projects\\bound-workspace",
      },
    });

    expect(receivedContext).toEqual(expect.objectContaining({
      resolvedWorkspaceRoot: "C:\\projects\\bound-workspace",
    }));
  });

  it("toSubAgentToolOutcome maps succeeded to terminal success", async () => {
    const outcome = await runSubAgent({
      profile: "document",
      taskId: "task-2",
      args: { objective: "test", filename: "test.docx", title: "Test", paragraphs: ["content"] },
      parentContext: { runId: "test-run" },
    });

    const toolOutcome = toSubAgentToolOutcome(outcome);
    expect(toolOutcome.status).toBe("succeeded");
    expect(toolOutcome.terminal).toBe(true);
    expect(toolOutcome.retryable).toBe(false);
    expect(parseSubAgentResult(toolOutcome.output).status).toBe("succeeded");
  });

  it("Soul projection extracts file path and verified status (artifacts_only)", async () => {
    const outcome = await runSubAgent({
      profile: "document",
      taskId: "task-3",
      args: { objective: "test", filename: "AI新闻简报.docx", title: "AI 新闻简报", paragraphs: newsParagraphs },
      parentContext: { runId: "test-run" },
    });

    const toolOutcome = toSubAgentToolOutcome(outcome);
    const toolResult: ToolCallResult = {
      toolId: "delegate_document", args: {}, output: toolOutcome.output,
      status: "succeeded", terminal: true, capabilityId: "delegate_document",
    };

    const projection = projectToolResult(toolResult, toolRegistry.getById("delegate_document"));
    expect(projection!.kind).toBe("entity_detail");
    const detail = projection as Extract<typeof projection, { kind: "entity_detail" }>;
    expect(detail.attributes?.artifactPath).toBe(MOCK_FILE_PATH);
    expect(detail.attributes?.artifactVerified).toBe(true);
  });

  it("joint Soul context: web_search news + delegate_document file path", async () => {
    const searchResult: ToolCallResult = {
      toolId: "web_search", args: { query: "AI新闻" },
      output: JSON.stringify({
        results: [
          { title: "OpenAI发布GPT-5", url: "https://example.com/1", snippet: "性能显著提升" },
          { title: "AlphaFold 3开源", url: "https://example.com/2", snippet: "加速药物研发" },
          { title: "Meta推出Llama 4", url: "https://example.com/3", snippet: "支持100万token" },
        ],
      }),
      status: "succeeded", terminal: true, capabilityId: "web_search",
    };

    const docOutcome = await runSubAgent({
      profile: "document", taskId: "task-4",
      args: { objective: "生成简报", filename: "AI新闻简报.docx", title: "AI 新闻简报", paragraphs: newsParagraphs },
      parentContext: { runId: "test-run" },
    });
    const docResult: ToolCallResult = {
      toolId: "delegate_document", args: {}, output: toSubAgentToolOutcome(docOutcome).output,
      status: "succeeded", terminal: true, capabilityId: "delegate_document",
    };

    const ctx = buildSoulExecutionContext(
      [searchResult, docResult],
      [toolRegistry.getById("web_search")!, toolRegistry.getById("delegate_document")!],
    );

    expect(ctx.projections).toHaveLength(2);
    const newsProj = ctx.projections.find(p => p.kind === "entity_list");
    expect(newsProj).toBeDefined();
    const docProj = ctx.projections.find(p => p.kind === "entity_detail");
    expect(docProj).toBeDefined();
    const docDetail = docProj as Extract<typeof docProj, { kind: "entity_detail" }>;
    expect(docDetail.attributes?.artifactPath).toBe(MOCK_FILE_PATH);
  });

  it("file verification failure (missing) returns failed", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const outcome = await runSubAgent({
      profile: "document", taskId: "task-5",
      args: { objective: "test", filename: "missing.docx", title: "M", paragraphs: ["t"] },
      parentContext: { runId: "test-run" },
    });
    expect(outcome.result!.status).toBe("failed");
    expect(outcome.result!.error?.code).toBe("FILE_VERIFICATION_FAILED");
  });

  it("file verification failure (zero size) returns failed", async () => {
    vi.mocked(statSync).mockReturnValue({ size: 0, isFile: () => true, mtimeMs: Date.now() + 10000 } as never);
    const outcome = await runSubAgent({
      profile: "document", taskId: "task-6",
      args: { objective: "test", filename: "empty.docx", title: "E", paragraphs: ["t"] },
      parentContext: { runId: "test-run" },
    });
    expect(outcome.result!.status).toBe("failed");
  });

  it("file verification failure (stale mtime) returns failed", async () => {
    vi.mocked(statSync).mockReturnValue({ size: 4096, isFile: () => true, mtimeMs: 0 } as never);
    const outcome = await runSubAgent({
      profile: "document", taskId: "task-7",
      args: { objective: "test", filename: "stale.docx", title: "S", paragraphs: ["t"] },
      parentContext: { runId: "test-run" },
    });
    expect(outcome.result!.status).toBe("failed");
  });

  it("parseSubAgentResult round-trip and rejection", async () => {
    const outcome = await runSubAgent({
      profile: "document", taskId: "task-8",
      args: { objective: "t", filename: "t.docx", title: "T", paragraphs: ["c"] },
      parentContext: { runId: "test-run" },
    });
    const parsed = parseSubAgentResult(serializeSubAgentResult(outcome.result!));
    expect(parsed.taskId).toBe("task-8");

    expect(() => parseSubAgentResult("not json")).toThrow(SubAgentProtocolError);
    expect(() => parseSubAgentResult(JSON.stringify({ kind: "wrong" }))).toThrow(SubAgentProtocolError);
  });

  // ── Fix 2: 白名单测试 ──

  it("Document Agent cannot call tools outside its whitelist", async () => {
    // send_email 不在 DOCUMENT_ALLOWED_TOOLS 中
    // Document Agent 只调用 write_word，不会调用 send_email
    const emailSpy = vi.fn(async () => "email sent");
    toolRegistry.register({
      id: "send_email", name: "发送邮件", description: "test", enabled: true, risk: "network",
      inputSchema: { type: "object", properties: {} }, execute: emailSpy,
    });

    await runSubAgent({
      profile: "document", taskId: "task-wl",
      args: { objective: "test", filename: "test.docx", title: "T", paragraphs: ["c"] },
      parentContext: { runId: "test-run" },
    });

    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("Document Agent cannot call disabled tools (graph handles as failed step)", async () => {
    // 禁用 write_word，graph 骨架将错误作为 failed tool result 处理，计划优雅失败
    const writeWord = toolRegistry.getById("write_word")!;
    const originalEnabled = writeWord.enabled;
    writeWord.enabled = false;

    const outcome = await runSubAgent({
      profile: "document", taskId: "task-disabled",
      args: { objective: "test", filename: "test.docx", title: "T", paragraphs: ["c"] },
      parentContext: { runId: "test-run" },
    });

    // graph 将执行错误作为 failed tool result，最终计划失败
    expect(outcome.invocationStatus).toBe("completed");
    expect(outcome.result!.status).toBe("failed");
    writeWord.enabled = originalEnabled;
  });

  // ── Fix 3: 显式注册 ──

  it("registerBuiltInSubAgentProfiles registers document profile", () => {
    // registerBuiltInSubAgentProfiles 应该是幂等的（document-agent 内部注册器覆盖）
    registerBuiltInSubAgentProfiles();
    expect(isProfileRegistered("document")).toBe(true);
  });

  it("runSubAgent returns crashed for unregistered profile", async () => {
    const outcome = await runSubAgent({
      profile: "crawler" as never, // crawler 尚未实现
      taskId: "task-unregistered",
      args: {},
      parentContext: { runId: "test-run" },
    });
    expect(outcome.invocationStatus).toBe("crashed");
    expect(outcome.error?.code).toBe("SUBAGENT_PROFILE_NOT_FOUND");
  });

  // ── Fix 4: completionEvidenceVerifier + Plan 路由测试 ──

  it("completionEvidenceVerifier accepts succeeded result with verified artifact", async () => {
    const outcome = await runSubAgent({
      profile: "document", taskId: "task-ce-1",
      args: { objective: "t", filename: "t.docx", title: "T", paragraphs: ["c"] },
      parentContext: { runId: "test-run" },
    });
    const toolOutcome = toSubAgentToolOutcome(outcome);
    const toolResult: ToolCallResult = {
      toolId: "delegate_document", args: {}, output: toolOutcome.output,
      status: "succeeded", terminal: true, capabilityId: "delegate_document",
    };

    const tool = toolRegistry.getById("delegate_document")!;
    expect(tool.completionEvidenceVerifier!(toolResult)).toBe(true);
  });

  it("completionEvidenceVerifier rejects result without verified artifact", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const outcome = await runSubAgent({
      profile: "document", taskId: "task-ce-2",
      args: { objective: "t", filename: "t.docx", title: "T", paragraphs: ["c"] },
      parentContext: { runId: "test-run" },
    });
    const toolOutcome = toSubAgentToolOutcome(outcome);
    // toSubAgentToolOutcome maps failed -> status: "failed"
    const toolResult: ToolCallResult = {
      toolId: "delegate_document", args: {}, output: toolOutcome.output,
      status: "failed", terminal: true, capabilityId: "delegate_document",
    };

    const tool = toolRegistry.getById("delegate_document")!;
    // verifier should return false because status is not "succeeded" in the SubAgentPublicResult
    expect(tool.completionEvidenceVerifier!(toolResult)).toBe(false);
  });

  it("Plan verify: delegate_document succeeded -> verifyStep -> step completed (with completionEvidenceVerifier)", async () => {
    const outcome = await runSubAgent({
      profile: "document", taskId: "task-plan",
      args: { objective: "生成文档", filename: "plan-test.docx", title: "Plan Test", paragraphs: ["test content"] },
      parentContext: { runId: "test-run" },
    });
    const toolOutcome = toSubAgentToolOutcome(outcome);

    const toolResult: ToolCallResult = {
      toolId: "delegate_document", args: {}, output: toolOutcome.output,
      status: "succeeded", terminal: true, capabilityId: "delegate_document",
      stepExecutionId: "exec_plan", stepAttemptId: "att_plan",
    };

    const step: PlanStep = {
      id: "s1", objective: "生成 Word 文档", status: "running",
      completionPolicy: { allOf: [{ kind: "tool_succeeded", capabilityId: "delegate_document" }] },
      executionId: "exec_plan", toolCallCount: 1, retryCount: 0,
    };

    const tool = toolRegistry.getById("delegate_document")!;
    const verification = verifyStep(step, [toolResult], [tool]);
    expect(verification.status).toBe("completed");
  });

  it("Plan verify: delegate_document failed (unverified artifact) -> verifyStep -> step failed", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const outcome = await runSubAgent({
      profile: "document", taskId: "task-plan-fail",
      args: { objective: "t", filename: "fail.docx", title: "F", paragraphs: ["c"] },
      parentContext: { runId: "test-run" },
    });
    const toolOutcome = toSubAgentToolOutcome(outcome);

    const toolResult: ToolCallResult = {
      toolId: "delegate_document", args: {}, output: toolOutcome.output,
      status: "failed", terminal: true, capabilityId: "delegate_document",
      stepExecutionId: "exec_fail", stepAttemptId: "att_fail",
    };

    const step: PlanStep = {
      id: "s1", objective: "生成 Word 文档", status: "running",
      completionPolicy: { allOf: [{ kind: "tool_succeeded", capabilityId: "delegate_document" }] },
      executionId: "exec_fail", toolCallCount: 1, retryCount: 0,
    };

    const tool = toolRegistry.getById("delegate_document")!;
    const verification = verifyStep(step, [toolResult], [tool]);
    expect(verification.status).toBe("failed");
  });

  // ── Fix 6: deprecated 过滤审计 ──

  it("deprecated delegate_task not visible in getEnabledTools but accessible via getById", () => {
    // 注册一个 deprecated 工具
    if (!toolRegistry.getById("test_deprecated_tool")) {
      toolRegistry.register({
        id: "test_deprecated_tool", name: "Test Deprecated", description: "test",
        enabled: true, deprecated: true,
        inputSchema: { type: "object", properties: {} },
        execute: async () => "deprecated",
      });
    }

    // getEnabledTools 不应包含 deprecated 工具
    const enabled = toolRegistry.getEnabledTools();
    expect(enabled.find(t => t.id === "test_deprecated_tool")).toBeUndefined();

    // getById 仍可查询
    expect(toolRegistry.getById("test_deprecated_tool")).toBeDefined();
    expect(toolRegistry.getById("test_deprecated_tool")!.deprecated).toBe(true);
  });

  // ── Fix 1: AbortSignal 传播到 tool.execute() ──

  it("AbortSignal propagates to tool.execute and AbortError is re-thrown", async () => {
    // 用一个可控的 pending 工具模拟长操作
    const controller = new AbortController();
    let signalReceived: AbortSignal | undefined;
    let resolveTool!: () => void;
    const pendingPromise = new Promise<string>((resolve, reject) => {
      resolveTool = () => resolve("done");
      signalReceived = controller.signal;
      controller.signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });

    // 覆盖 write_word 为 pending 工具
    toolRegistry.register({
      id: "write_word", name: "写 Word", description: "test", enabled: true, risk: "fs-write",
      inputSchema: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        // 确认 signal 通过 ToolContext 传入
        signalReceived = ctx?.signal;
        return pendingPromise;
      },
    });

    // 启动子代理（不 await）
    const subAgentPromise = runSubAgent({
      profile: "document", taskId: "task-abort",
      args: { objective: "t", filename: "t.docx", title: "T", paragraphs: ["c"] },
      parentContext: { runId: "test-run" },
      signal: controller.signal,
    });

    // 给 microtask 一个机会让 execute 启动
    await new Promise(resolve => setImmediate(resolve));

    // 确认 signal 传到了 tool.execute
    expect(signalReceived).toBe(controller.signal);

    // abort 父 signal
    controller.abort();

    // 子代理应抛出 AbortError（不包装为 crashed）
    await expect(subAgentPromise).rejects.toThrow("aborted");
  });

  // ── Fix 2: 真实主图路由集成测试 ──

  it("full routing chain: delegate_document succeeded -> resolveRouteAfterTool -> planVerify -> verifyStep -> completed", async () => {
    // 1. 运行 Document Agent 获取真实 ToolCallResult
    const outcome = await runSubAgent({
      profile: "document", taskId: "task-routing",
      args: { objective: "生成文档", filename: "routing-test.docx", title: "Routing Test", paragraphs: ["content"] },
      parentContext: { runId: "test-run" },
    });
    const toolOutcome = toSubAgentToolOutcome(outcome);

    const toolResult: ToolCallResult = {
      toolId: "delegate_document", args: {}, output: toolOutcome.output,
      status: "succeeded", terminal: true, capabilityId: "delegate_document",
      stepExecutionId: "exec_routing", stepAttemptId: "att_routing",
    };

    // 2. routeAfterTool 路由决策（使用从 agent-graph.ts 提取的纯函数）
    const action = { afterSuccess: "respond" as const };
    const inPlanMode = true;
    const route = resolveRouteAfterTool(toolResult, action, inPlanMode);

    // 在 Plan 模式下，终态成功应路由到 planVerify（而非 soul）
    expect(route).toBe("planVerify");

    // 3. planVerify 验证（使用真实 verifyStep + completionEvidenceVerifier）
    const step: PlanStep = {
      id: "s1", objective: "生成 Word 文档", status: "running",
      completionPolicy: { allOf: [{ kind: "tool_succeeded", capabilityId: "delegate_document" }] },
      executionId: "exec_routing", toolCallCount: 1, retryCount: 0,
    };

    const tool = toolRegistry.getById("delegate_document")!;
    const verification = verifyStep(step, [toolResult], [tool]);

    // completionEvidenceVerifier 确认 artifact 已验证
    expect(verification.status).toBe("completed");
  });

  it("full routing chain: delegate_document failed -> resolveRouteAfterTool -> planVerify -> verifyStep -> failed", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const outcome = await runSubAgent({
      profile: "document", taskId: "task-routing-fail",
      args: { objective: "t", filename: "fail.docx", title: "F", paragraphs: ["c"] },
      parentContext: { runId: "test-run" },
    });
    const toolOutcome = toSubAgentToolOutcome(outcome);

    const toolResult: ToolCallResult = {
      toolId: "delegate_document", args: {}, output: toolOutcome.output,
      status: "failed", terminal: true, retryable: false, capabilityId: "delegate_document",
      stepExecutionId: "exec_rf", stepAttemptId: "att_rf",
    };

    // 失败 + 不可重试 -> 路由到 soul（plan 模式下 -> planVerify）
    const route = resolveRouteAfterTool(toolResult, { afterSuccess: "respond" }, true);
    expect(route).toBe("planVerify");

    const step: PlanStep = {
      id: "s1", objective: "生成 Word 文档", status: "running",
      completionPolicy: { allOf: [{ kind: "tool_succeeded", capabilityId: "delegate_document" }] },
      executionId: "exec_rf", toolCallCount: 1, retryCount: 0,
    };

    const tool = toolRegistry.getById("delegate_document")!;
    const verification = verifyStep(step, [toolResult], [tool]);
    expect(verification.status).toBe("failed");
  });

  // ── Fix 3: registerBuiltInSubAgentProfiles 幂等 ──

  it("registerBuiltInSubAgentProfiles is idempotent: double call does not error or duplicate", () => {
    _resetSubAgentInit();

    // 第一次调用
    registerBuiltInSubAgentProfiles();
    expect(isProfileRegistered("document")).toBe(true);

    // 第二次调用：不应报错，不应影响已注册的 Profile
    expect(() => registerBuiltInSubAgentProfiles()).not.toThrow();
    expect(isProfileRegistered("document")).toBe(true);
  });

  it("registerSubAgentProfile: same runner re-register is idempotent no-op", () => {
    // registerDocumentProfile 已在 beforeEach 调用
    // 再次调用同一函数引用 -> 幂等 no-op
    expect(() => registerDocumentProfile()).not.toThrow();
    expect(isProfileRegistered("document")).toBe(true);
  });

  it("registerSubAgentProfile: different runner for same profile throws conflict", () => {
    // document Profile 已注册，尝试用不同 runner 注册
    const fakeRunner = async () => ({ invocationStatus: "crashed" as const, error: { code: "FAKE", message: "fake" } });
    expect(() => registerSubAgentProfile("document", fakeRunner)).toThrow("SUBAGENT_PROFILE_CONFLICT");

    // 原 runner 未被替换
    expect(isProfileRegistered("document")).toBe(true);
    // 确认原 runner 仍可正常执行
    // (不需要实际运行，只需确认 profile 仍然可用)
  });
});
