import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock fs to avoid real file operations
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ size: 4096, isFile: () => true, mtimeMs: Date.now() })),
}));

import { existsSync, statSync } from "fs";
import { toolRegistry } from "../tool-registry";
// 导入 document-agent 触发 Profile 注册副作用
import "./document-agent";
import { runSubAgent } from "./runner";
import { toSubAgentToolOutcome } from "./outcome-adapter";
import { parseSubAgentResult, serializeSubAgentResult, SubAgentProtocolError } from "./result-parser";
import { projectToolResult, buildSoulExecutionContext } from "../soul-execution-context";
import { verifyStep } from "../task-plan";
import type { ToolCallResult } from "../types";
import type { PlanStep } from "../task-plan";

const MOCK_FILE_PATH = "C:\\Users\\Test\\Desktop\\AI新闻简报.docx";

/** 注册测试所需的 mock 工具 */
function ensureTestTools() {
  if (!toolRegistry.getById("write_word")) {
    toolRegistry.register({
      id: "write_word",
      name: "写 Word",
      description: "test",
      enabled: true,
      risk: "fs-write",
      inputSchema: { type: "object", properties: {} },
      execute: async () => `[write_word] 已生成：${MOCK_FILE_PATH}`,
    });
  }

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
      inputSchema: { type: "object", properties: {} },
      execute: async () => { throw new Error("SUBAGENT_MUST_USE_SPECIAL_EXECUTOR"); },
    });
  }

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
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(statSync).mockReturnValue({
      size: 4096,
      isFile: () => true,
      mtimeMs: Date.now() + 10000, // 确保晚于 runStartMs
    } as never);
  });

  it("generates Word, verifies file, returns verified artifact (artifacts_only, no findings)", async () => {
    const outcome = await runSubAgent("document", "task-1", {
      objective: "将新闻资料生成 Word 简报",
      filename: "AI新闻简报.docx",
      title: "AI 新闻简报",
      paragraphs: newsParagraphs,
      style: "default",
    });

    expect(outcome.invocationStatus).toBe("completed");
    const result = outcome.result!;

    // 文档生成成功
    expect(result.status).toBe("succeeded");
    expect(result.profile).toBe("document");

    // artifacts_only：findings 为空，新闻信息来自 web_search 投影
    expect(result.findings).toHaveLength(0);

    // 文件路径已验证
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path).toBe(MOCK_FILE_PATH);
    expect(result.artifacts[0].verified).toBe(true);
    expect(result.artifacts[0].sizeBytes).toBe(4096);

    // 完成证据
    expect(result.completionEvidence).toHaveLength(1);
    expect(result.completionEvidence[0].satisfied).toBe(true);

    // primaryArtifact
    expect(result.primaryArtifact).toBeDefined();
    expect(result.primaryArtifact!.path).toBe(MOCK_FILE_PATH);
  });

  it("toSubAgentToolOutcome maps succeeded to terminal success", async () => {
    const outcome = await runSubAgent("document", "task-2", {
      objective: "test",
      filename: "test.docx",
      title: "Test",
      paragraphs: ["content"],
    });

    const toolOutcome = toSubAgentToolOutcome(outcome);

    expect(toolOutcome.status).toBe("succeeded");
    expect(toolOutcome.terminal).toBe(true);
    expect(toolOutcome.retryable).toBe(false);
    const parsed = parseSubAgentResult(toolOutcome.output);
    expect(parsed.status).toBe("succeeded");
  });

  it("Soul projection extracts file path and verified status (artifacts_only)", async () => {
    const outcome = await runSubAgent("document", "task-3", {
      objective: "test",
      filename: "AI新闻简报.docx",
      title: "AI 新闻简报",
      paragraphs: newsParagraphs,
    });

    const toolOutcome = toSubAgentToolOutcome(outcome);
    const toolResult: ToolCallResult = {
      toolId: "delegate_document",
      args: {},
      output: toolOutcome.output,
      status: "succeeded",
      terminal: true,
      capabilityId: "delegate_document",
    };

    const tool = toolRegistry.getById("delegate_document");
    const projection = projectToolResult(toolResult, tool);

    expect(projection).toBeDefined();
    expect(projection!.kind).toBe("entity_detail");
    const detail = projection as Extract<typeof projection, { kind: "entity_detail" }>;
    expect(detail.attributes?.artifactPath).toBe(MOCK_FILE_PATH);
    expect(detail.attributes?.artifactVerified).toBe(true);
    expect(detail.attributes?.artifactName).toBe("AI新闻简报.docx");
  });

  it("joint Soul context: web_search news + delegate_document file path", async () => {
    // web_search ToolCallResult（新闻内容）
    const searchResult: ToolCallResult = {
      toolId: "web_search",
      args: { query: "AI新闻" },
      output: JSON.stringify({
        results: [
          { title: "OpenAI发布GPT-5", url: "https://example.com/1", snippet: "性能显著提升" },
          { title: "AlphaFold 3开源", url: "https://example.com/2", snippet: "加速药物研发" },
          { title: "Meta推出Llama 4", url: "https://example.com/3", snippet: "支持100万token" },
        ],
      }),
      status: "succeeded",
      terminal: true,
      capabilityId: "web_search",
    };

    // delegate_document ToolCallResult（文件路径）
    const docOutcome = await runSubAgent("document", "task-4", {
      objective: "生成新闻简报",
      filename: "AI新闻简报.docx",
      title: "AI 新闻简报",
      paragraphs: newsParagraphs,
    });
    const docToolOutcome = toSubAgentToolOutcome(docOutcome);
    const docResult: ToolCallResult = {
      toolId: "delegate_document",
      args: {},
      output: docToolOutcome.output,
      status: "succeeded",
      terminal: true,
      capabilityId: "delegate_document",
    };

    // 联合投影
    const tools = [
      toolRegistry.getById("web_search")!,
      toolRegistry.getById("delegate_document")!,
    ];
    const ctx = buildSoulExecutionContext([searchResult, docResult], tools);

    // 同时包含新闻内容（entity_list）和文件路径（entity_detail）
    expect(ctx.projections).toHaveLength(2);

    const newsProjection = ctx.projections.find((p) => p.kind === "entity_list");
    expect(newsProjection).toBeDefined();
    const newsList = newsProjection as Extract<typeof newsProjection, { kind: "entity_list" }>;
    expect(newsList.items).toHaveLength(3);
    expect(newsList.items[0].title).toBe("OpenAI发布GPT-5");

    const docProjection = ctx.projections.find((p) => p.kind === "entity_detail");
    expect(docProjection).toBeDefined();
    const docDetail = docProjection as Extract<typeof docProjection, { kind: "entity_detail" }>;
    expect(docDetail.attributes?.artifactPath).toBe(MOCK_FILE_PATH);
    expect(docDetail.attributes?.artifactVerified).toBe(true);
  });

  it("file verification failure (file missing) returns failed status", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const outcome = await runSubAgent("document", "task-5", {
      objective: "test",
      filename: "missing.docx",
      title: "Missing",
      paragraphs: ["test"],
    });

    const result = outcome.result!;
    expect(result.status).toBe("failed");
    expect(result.artifacts[0].verified).toBe(false);
    expect(result.error?.code).toBe("FILE_VERIFICATION_FAILED");
    expect(result.error?.recoverable).toBe(true);
  });

  it("file verification failure (zero size) returns failed status", async () => {
    vi.mocked(statSync).mockReturnValue({
      size: 0,
      isFile: () => true,
      mtimeMs: Date.now(),
    } as never);

    const outcome = await runSubAgent("document", "task-6", {
      objective: "test",
      filename: "empty.docx",
      title: "Empty",
      paragraphs: ["test"],
    });

    expect(outcome.result!.status).toBe("failed");
    expect(outcome.result!.error?.code).toBe("FILE_VERIFICATION_FAILED");
  });

  it("file verification failure (stale mtime) returns failed status", async () => {
    vi.mocked(statSync).mockReturnValue({
      size: 4096,
      isFile: () => true,
      mtimeMs: 0, // 远早于运行开始时间
    } as never);

    const outcome = await runSubAgent("document", "task-7", {
      objective: "test",
      filename: "stale.docx",
      title: "Stale",
      paragraphs: ["test"],
    });

    expect(outcome.result!.status).toBe("failed");
    expect(outcome.result!.error?.code).toBe("FILE_VERIFICATION_FAILED");
  });

  it("parseSubAgentResult round-trips through serialize/deserialize", async () => {
    const outcome = await runSubAgent("document", "task-8", {
      objective: "test",
      filename: "test.docx",
      title: "Test",
      paragraphs: ["content"],
    });

    const serialized = serializeSubAgentResult(outcome.result!);
    const parsed = parseSubAgentResult(serialized);

    expect(parsed.kind).toBe("subagent_result");
    expect(parsed.version).toBe(1);
    expect(parsed.taskId).toBe("task-8");
  });

  it("parseSubAgentResult rejects invalid input", () => {
    expect(() => parseSubAgentResult("not json")).toThrow(SubAgentProtocolError);
    expect(() => parseSubAgentResult(JSON.stringify({ kind: "wrong" }))).toThrow(SubAgentProtocolError);
    expect(() => parseSubAgentResult(JSON.stringify({ kind: "subagent_result", version: 99 }))).toThrow(SubAgentProtocolError);
  });

  it("Plan mode: delegate_document succeeded -> verifyStep -> step completed", async () => {
    const docOutcome = await runSubAgent("document", "task-9", {
      objective: "生成文档",
      filename: "plan-test.docx",
      title: "Plan Test",
      paragraphs: ["test content"],
    });
    const toolOutcome = toSubAgentToolOutcome(docOutcome);

    // 模拟主图构造的 ToolCallResult
    const toolResult: ToolCallResult = {
      toolId: "delegate_document",
      args: {},
      output: toolOutcome.output,
      status: "succeeded",
      terminal: true,
      capabilityId: "delegate_document",
      stepExecutionId: "exec_test",
      stepAttemptId: "att_test",
    };

    // 模拟一个 Plan 步骤
    const step: PlanStep = {
      id: "s1",
      objective: "生成 Word 文档",
      status: "running",
      completionPolicy: {
        allOf: [{ kind: "tool_succeeded", capabilityId: "delegate_document" }],
      },
      executionId: "exec_test",
      toolCallCount: 1,
      retryCount: 0,
    };

    const tool = toolRegistry.getById("delegate_document");
    const verification = verifyStep(step, [toolResult], [tool!]);

    expect(verification.status).toBe("completed");
  });
});
