import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock toolRegistry to control web_search and fetch_url behavior
vi.mock("../tool-registry", () => ({
  toolRegistry: {
    getById: vi.fn(),
    getEnabledTools: vi.fn(() => []),
    register: vi.fn(),
  },
}));

import { toolRegistry } from "../tool-registry";
import { runSubAgent } from "./runner";
import { registerSearchProfile } from "./search-agent";
import { toSubAgentToolOutcome } from "./outcome-adapter";
import { parseSubAgentResult } from "./result-parser";
import { buildSoulExecutionContext, projectToolResult } from "../soul-execution-context";
import type { ToolCallResult } from "../types";

const mockSearchResults = {
  success: true,
  query: "AI新闻",
  resultCount: 3,
  results: [
    { title: "OpenAI发布GPT-5", url: "https://example.com/1", snippet: "性能显著提升", source: "TechCrunch" },
    { title: "AlphaFold 3开源", url: "https://example.com/2", snippet: "加速药物研发", source: "Nature" },
    { title: "Meta推出Llama 4", url: "https://example.com/3", snippet: "支持100万token", source: "Meta Blog" },
  ],
};

const mockFetchResult = `URL: https://example.com/1
Content-Type: text/html

# OpenAI发布GPT-5

OpenAI今日发布了最新的GPT-5模型，在推理和编码任务上性能显著提升。

## 主要改进

1. 推理能力提升40%
2. 代码生成准确率提高25%
3. 支持更长的上下文窗口`;

describe("Search Agent end-to-end projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // 注册 search profile
    registerSearchProfile();

    // Mock web_search 工具
    vi.mocked(toolRegistry.getById).mockImplementation((id: string) => {
      if (id === "web_search") {
        return {
          id: "web_search",
          name: "联网搜索",
          description: "test",
          enabled: true,
          risk: "network",
          inputSchema: { type: "object", properties: {} },
          execute: async () => JSON.stringify(mockSearchResults),
        };
      }
      if (id === "fetch_url") {
        return {
          id: "fetch_url",
          name: "读取网页",
          description: "test",
          enabled: true,
          risk: "network",
          inputSchema: { type: "object", properties: {} },
          execute: async () => mockFetchResult,
        };
      }
      return undefined;
    });
  });

  it("full pipeline: search -> fetch -> SubAgentPublicResult with findings and sources", async () => {
    const outcome = await runSubAgent({
      profile: "search",
      taskId: "search-task-1",
      args: {
        objective: "搜索最新AI新闻",
        requiresDeepReading: true,
      },
      parentContext: { runId: "test-run" },
    });

    expect(outcome.invocationStatus).toBe("completed");
    const result = outcome.result!;

    // 验证结果状态
    expect(result.status).toBe("succeeded");
    expect(result.profile).toBe("search");

    // 验证 findings
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.length).toBeLessThanOrEqual(10);

    // 验证每个 finding 都有来源
    for (const finding of result.findings) {
      expect(finding.source).toBeDefined();
      expect(finding.content.length).toBeGreaterThan(0);
    }

    // 验证 completionEvidence
    expect(result.completionEvidence).toHaveLength(1);
    expect(result.completionEvidence[0].satisfied).toBe(true);

    // 验证 summary
    expect(result.summary).toContain("搜索");
    expect(result.summary).toContain("结果");
  });

  it("toSubAgentToolOutcome maps search result correctly", async () => {
    const outcome = await runSubAgent({
      profile: "search",
      taskId: "search-task-2",
      args: { objective: "搜索AI新闻" },
      parentContext: { runId: "test-run" },
    });

    const toolOutcome = toSubAgentToolOutcome(outcome);
    expect(toolOutcome.status).toBe("succeeded");
    expect(toolOutcome.terminal).toBe(true);
    expect(toolOutcome.retryable).toBe(false);

    // 验证 output 可以被 parseSubAgentResult 解析
    const parsed = parseSubAgentResult(toolOutcome.output);
    expect(parsed.kind).toBe("subagent_result");
    expect(parsed.version).toBe(1);
    expect(parsed.profile).toBe("search");
  });

  it("Soul projection extracts search findings with sources", async () => {
    const outcome = await runSubAgent({
      profile: "search",
      taskId: "search-task-3",
      args: { objective: "搜索AI新闻" },
      parentContext: { runId: "test-run" },
    });

    const toolOutcome = toSubAgentToolOutcome(outcome);

    // 构建 ToolCallResult 模拟主图
    const toolResult: ToolCallResult = {
      toolId: "delegate_search",
      args: { objective: "搜索AI新闻" },
      output: toolOutcome.output,
      status: "succeeded",
      terminal: true,
      capabilityId: "delegate_search",
    };

    // 注册 delegate_search 工具用于投影
    vi.mocked(toolRegistry.getById).mockImplementation((id: string) => {
      if (id === "delegate_search") {
        return {
          id: "delegate_search",
          name: "委托搜索",
          description: "test",
          enabled: true,
          capability: "delegate_search",
          executionKind: "subagent",
          subAgentProfile: "search",
          ledgerPolicy: "bypass",
          soulActionLabel: "搜索信息",
          soulProjection: {
            projector: "entity_list",
            source: "external_untrusted",
            itemsPath: "findings",
            fields: {
              title: "title",
              content: "content",
              source: "source",
            },
            maxItems: 10,
          },
          completionEvidence: [{ kind: "tool_succeeded" }],
          inputSchema: { type: "object", properties: {} },
          execute: async () => { throw new Error("SUBAGENT_MUST_USE_SPECIAL_EXECUTOR"); },
        };
      }
      return undefined;
    });

    const tool = toolRegistry.getById("delegate_search")!;
    const projection = projectToolResult(toolResult, tool);

    expect(projection).toBeDefined();
    expect(projection!.kind).toBe("entity_list");

    const list = projection as Extract<typeof projection, { kind: "entity_list" }>;
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.length).toBeLessThanOrEqual(10);

    // 验证每个 item 都有 title 和 source
    for (const item of list.items) {
      expect(item.title).toBeDefined();
      expect(item.attributes?.source).toBeDefined();
    }
  });

  it("partial result: search succeeds but limited findings -> partial status", async () => {
    // Mock web_search 返回较少结果
    vi.mocked(toolRegistry.getById).mockImplementation((id: string) => {
      if (id === "web_search") {
        return {
          id: "web_search",
          name: "联网搜索",
          description: "test",
          enabled: true,
          risk: "network",
          inputSchema: { type: "object", properties: {} },
          execute: async () => JSON.stringify({
            success: true,
            query: "小众话题",
            resultCount: 1,
            results: [
              { title: "小众结果", url: "https://example.com/1", snippet: "简短摘要" },
            ],
          }),
        };
      }
      return undefined;
    });

    const outcome = await runSubAgent({
      profile: "search",
      taskId: "search-task-4",
      args: { objective: "搜索小众话题" },
      parentContext: { runId: "test-run" },
    });

    const result = outcome.result!;

    // 验证 partial 状态
    expect(result.status).toBe("partial");
    expect(result.error?.code).toBe("INSUFFICIENT_FINDINGS");
    expect(result.error?.recoverable).toBe(true);
  });

  it("failed result: search returns no results -> budget exhaustion returns partial", async () => {
    // Mock web_search 返回空结果
    vi.mocked(toolRegistry.getById).mockImplementation((id: string) => {
      if (id === "web_search") {
        return {
          id: "web_search",
          name: "联网搜索",
          description: "test",
          enabled: true,
          risk: "network",
          inputSchema: { type: "object", properties: {} },
          execute: async () => JSON.stringify({
            success: true,
            query: "不存在的内容",
            resultCount: 0,
            results: [],
          }),
        };
      }
      return undefined;
    });

    const outcome = await runSubAgent({
      profile: "search",
      taskId: "search-task-5",
      args: { objective: "搜索不存在的内容" },
      parentContext: { runId: "test-run" },
    });

    const result = outcome.result!;

    // 搜索返回空结果时，verify 步骤会循环直到预算耗尽
    // 预算耗尽时返回 partial（有成功工具调用但无有效结果）
    expect(result.status).toBe("partial");
    expect(result.findings).toHaveLength(0);
  });

  it("joint Soul context: search findings + document artifact", async () => {
    // 模拟搜索结果
    const searchOutcome = await runSubAgent({
      profile: "search",
      taskId: "search-task-6",
      args: { objective: "搜索AI新闻" },
      parentContext: { runId: "test-run" },
    });

    const searchToolOutcome = toSubAgentToolOutcome(searchOutcome);
    const searchResult: ToolCallResult = {
      toolId: "delegate_search",
      args: { objective: "搜索AI新闻" },
      output: searchToolOutcome.output,
      status: "succeeded",
      terminal: true,
      capabilityId: "delegate_search",
    };

    // 模拟文档结果
    const docResult: ToolCallResult = {
      toolId: "delegate_document",
      args: {},
      output: JSON.stringify({
        kind: "subagent_result",
        version: 1,
        taskId: "doc-task",
        profile: "document",
        status: "succeeded",
        summary: "文档已生成",
        findings: [],
        artifacts: [{ id: "a1", name: "AI新闻.docx", path: "/path/to/file.docx", verified: true }],
        completionEvidence: [],
        primaryArtifact: { name: "AI新闻.docx", path: "/path/to/file.docx", verified: true },
      }),
      status: "succeeded",
      terminal: true,
      capabilityId: "delegate_document",
    };

    // 构建联合投影
    vi.mocked(toolRegistry.getById).mockImplementation((id: string) => {
      if (id === "delegate_search") {
        return {
          id: "delegate_search",
          name: "委托搜索",
          description: "test",
          enabled: true,
          soulProjection: {
            projector: "entity_list",
            source: "external_untrusted",
            itemsPath: "findings",
            fields: { title: "title", content: "content", source: "source" },
            maxItems: 10,
          },
          inputSchema: { type: "object", properties: {} },
          execute: async () => "",
        };
      }
      if (id === "delegate_document") {
        return {
          id: "delegate_document",
          name: "委托文档",
          description: "test",
          enabled: true,
          soulProjection: {
            projector: "entity_detail",
            source: "trusted_internal",
            fields: {
              title: "summary",
              artifactName: "primaryArtifact.name",
              artifactPath: "primaryArtifact.path",
            },
          },
          inputSchema: { type: "object", properties: {} },
          execute: async () => "",
        };
      }
      return undefined;
    });

    const ctx = buildSoulExecutionContext(
      [searchResult, docResult],
      [
        toolRegistry.getById("delegate_search")!,
        toolRegistry.getById("delegate_document")!,
      ],
    );

    // 验证同时包含搜索结果和文档信息
    expect(ctx.projections).toHaveLength(2);

    const searchProjection = ctx.projections.find(p => p.kind === "entity_list");
    expect(searchProjection).toBeDefined();
    const searchList = searchProjection as Extract<typeof searchProjection, { kind: "entity_list" }>;
    expect(searchList.items.length).toBeGreaterThan(0);

    const docProjection = ctx.projections.find(p => p.kind === "entity_detail");
    expect(docProjection).toBeDefined();
    const docDetail = docProjection as Extract<typeof docProjection, { kind: "entity_detail" }>;
    expect(docDetail.attributes?.artifactPath).toBe("/path/to/file.docx");
  });
});
