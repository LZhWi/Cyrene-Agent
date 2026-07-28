import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock fs to avoid real file operations
vi.mock("fs", () => ({
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ size: 4096 })),
}));

import { existsSync, statSync } from "fs";
import { toolRegistry } from "../tool-registry";
import { runDocumentAgent } from "./document-agent";
import { toSubAgentToolOutcome } from "./outcome-adapter";
import { parseSubAgentResult, serializeSubAgentResult, SubAgentProtocolError } from "./result-parser";
import { projectToolResult } from "../soul-execution-context";
import type { ToolCallResult } from "../types";

const MOCK_FILE_PATH = "C:\\Users\\Test\\Desktop\\AI新闻简报.docx";

/** 注册测试所需的 mock 工具 */
function ensureTestTools() {
  // write_word mock：返回与真实工具相同格式的输出
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

  // delegate_document：与 built-in-tools.ts 中相同的 soulProjection 配置
  if (!toolRegistry.getById("delegate_document")) {
    toolRegistry.register({
      id: "delegate_document",
      name: "委托文档生成",
      description: "test",
      enabled: true,
      capability: "delegate_document",
      executionKind: "subagent",
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
    vi.mocked(statSync).mockReturnValue({ size: 4096 } as never);
  });

  it("generates Word, verifies file, returns findings + verified artifact", async () => {
    const outcome = await runDocumentAgent("task-1", {
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

    // 文件路径已验证
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].path).toBe(MOCK_FILE_PATH);
    expect(result.artifacts[0].verified).toBe(true);
    expect(result.artifacts[0].name).toBe("AI新闻简报.docx");
    expect(result.artifacts[0].sizeBytes).toBe(4096);

    // 完成证据
    expect(result.completionEvidence).toHaveLength(1);
    expect(result.completionEvidence[0].satisfied).toBe(true);
    expect(result.completionEvidence[0].evidenceRefs).toContain(MOCK_FILE_PATH);

    // 新闻内容作为 findings 传给 Soul
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0].content).toContain("GPT-5");
    expect(result.findings[1].content).toContain("AlphaFold");
    expect(result.findings[2].content).toContain("Llama 4");

    // primaryArtifact 扁平化字段
    expect(result.primaryArtifact).toBeDefined();
    expect(result.primaryArtifact!.path).toBe(MOCK_FILE_PATH);
    expect(result.primaryArtifact!.verified).toBe(true);
  });

  it("toSubAgentToolOutcome maps succeeded to terminal success", async () => {
    const outcome = await runDocumentAgent("task-2", {
      objective: "test",
      filename: "test.docx",
      title: "Test",
      paragraphs: ["content"],
    });

    const toolOutcome = toSubAgentToolOutcome(outcome);

    expect(toolOutcome.status).toBe("succeeded");
    expect(toolOutcome.terminal).toBe(true);
    expect(toolOutcome.retryable).toBe(false);
    // output 是可被 parseSubAgentResult 解析的 JSON
    const parsed = parseSubAgentResult(toolOutcome.output);
    expect(parsed.status).toBe("succeeded");
    expect(parsed.artifacts[0].path).toBe(MOCK_FILE_PATH);
  });

  it("Soul projection extracts file path and verified status", async () => {
    const outcome = await runDocumentAgent("task-3", {
      objective: "test",
      filename: "AI新闻简报.docx",
      title: "AI 新闻简报",
      paragraphs: newsParagraphs,
    });

    // 模拟主图构造的 ToolCallResult
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
    // title 来自 summary
    expect(detail.title).toContain("文档已生成");
    // artifact 信息从 primaryArtifact 提取
    expect(detail.attributes?.artifactPath).toBe(MOCK_FILE_PATH);
    expect(detail.attributes?.artifactVerified).toBe(true);
    expect(detail.attributes?.artifactName).toBe("AI新闻简报.docx");
  });

  it("file verification failure returns failed status with recoverable error", async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const outcome = await runDocumentAgent("task-4", {
      objective: "test",
      filename: "missing.docx",
      title: "Missing",
      paragraphs: ["test"],
    });

    const result = outcome.result!;
    expect(result.status).toBe("failed");
    expect(result.artifacts[0].verified).toBe(false);
    expect(result.error?.code).toBe("FILE_NOT_FOUND");
    expect(result.error?.recoverable).toBe(true);

    // toSubAgentToolOutcome 应映射为 failed + retryable
    const toolOutcome = toSubAgentToolOutcome(outcome);
    expect(toolOutcome.status).toBe("failed");
    expect(toolOutcome.retryable).toBe(true);
  });

  it("parseSubAgentResult round-trips through serialize/deserialize", async () => {
    const outcome = await runDocumentAgent("task-5", {
      objective: "test",
      filename: "test.docx",
      title: "Test",
      paragraphs: ["content"],
    });

    const serialized = serializeSubAgentResult(outcome.result!);
    const parsed = parseSubAgentResult(serialized);

    expect(parsed.kind).toBe("subagent_result");
    expect(parsed.version).toBe(1);
    expect(parsed.taskId).toBe("task-5");
    expect(parsed.profile).toBe("document");
    expect(parsed.status).toBe("succeeded");
  });

  it("parseSubAgentResult rejects invalid input", () => {
    expect(() => parseSubAgentResult("not json")).toThrow(SubAgentProtocolError);
    expect(() => parseSubAgentResult(JSON.stringify({ kind: "wrong" }))).toThrow(SubAgentProtocolError);
    expect(() => parseSubAgentResult(JSON.stringify({ kind: "subagent_result", version: 99 }))).toThrow(SubAgentProtocolError);
  });
});
