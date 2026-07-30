// Search Agent -- 搜索子代理 Profile
//
// 第一版垂直切片：使用模板计划（planStrategy: "template"），不调用 LLM。
// 根据目标自动生成 3 步计划：搜索 → 读取 → 验证。
// 工具白名单严格限制：只允许 web_search 和 fetch_url。
//
// 后续版本可升级为 LLM 动态规划（planStrategy: "llm"），支持：
// - 受限 Plan Schema（只允许搜索问题、来源覆盖目标、是否需要读取原网页、完成条件）
// - 禁止任意工具 ID
// - maxSteps 校验
// - 空计划和重复计划校验
// - Structured Output 失败与 Repair
// - 规划失败后的安全降级

import { registerSubAgentProfile } from "./runner";
import { runSubAgentGraph, buildFailedResult } from "./graph";
import type {
  SubAgentRunContext,
  SubAgentRunOutcome,
  SubAgentState,
  SubAgentProfileConfig,
  SubAgentPlan,
  SubAgentPublicResultV1,
  SubAgentFinding,
  SubAgentDecision,
} from "./types";
import type { PlanStep, StepVerificationResult } from "../task-plan";
import { generatePlanId, generateStepId } from "../task-plan";

/** Search Agent 工具白名单 */
const SEARCH_ALLOWED_TOOLS = new Set([
  "web_search",
  "fetch_url",
]);

/** 搜索结果结构 */
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

/** Search Profile 配置 */
const searchProfile: SubAgentProfileConfig = {
  id: "search",
  allowedTools: SEARCH_ALLOWED_TOOLS,
  budget: { maxSteps: 8, maxToolCalls: 12, maxReplans: 2, timeoutMs: 120_000 },

  createInitialPlan(ctx: SubAgentRunContext): SubAgentPlan {
    const now = Date.now();
    const objective = String(ctx.args.objective ?? "搜索信息");

    // 根据目标生成初始搜索步骤
    const steps: PlanStep[] = [];

    // 步骤1：初始搜索
    steps.push({
      id: generateStepId(),
      objective: `搜索: ${objective}`,
      status: "pending",
      completionPolicy: { allOf: [{ kind: "tool_succeeded", capabilityId: "web_search" }] },
      toolCallCount: 0,
      retryCount: 0,
    });

    // 步骤2：根据需要读取原网页（如果 args 中指定了需要深度阅读）
    if (ctx.args.requiresDeepReading) {
      steps.push({
        id: generateStepId(),
        objective: "读取关键网页获取详细信息",
        status: "pending",
        completionPolicy: { allOf: [{ kind: "tool_succeeded", capabilityId: "fetch_url" }] },
        toolCallCount: 0,
        retryCount: 0,
      });
    }

    // 步骤3：验证和整理结果
    steps.push({
      id: generateStepId(),
      objective: "验证搜索结果并整理 findings",
      status: "pending",
      completionPolicy: {},
      toolCallCount: 0,
      retryCount: 0,
    });

    return {
      id: generatePlanId(),
      goal: objective,
      steps,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
  },

  decide(state: SubAgentState): SubAgentDecision {
    const step = state.plan.steps.find(s => s.id === state.currentStepId);
    if (!step) return { action: "fail", reason: "无当前步骤", code: "NO_STEP", recoverable: false };

    // 步骤1：调用 web_search
    if (step.objective.startsWith("搜索:")) {
      const query = step.objective.replace("搜索:", "").trim();
      return {
        action: "call_tool",
        toolId: "web_search",
        args: { query },
      };
    }

    // 步骤2：读取原网页
    if (step.objective.includes("读取关键网页")) {
      // 从之前的搜索结果中提取 URL
      const searchResults = findSearchResults(state);
      const url = selectBestUrl(searchResults);
      if (url) {
        return {
          action: "call_tool",
          toolId: "fetch_url",
          args: { url, format: "markdown" },
        };
      }
      return { action: "skip" };
    }

    // 步骤3：验证和整理（跳过，由 verifyStep 处理）
    return { action: "skip" };
  },

  verifyStep(state: SubAgentState): StepVerificationResult {
    const step = state.plan.steps.find(s => s.id === state.currentStepId);
    if (!step) return { status: "failed", failureReason: "无当前步骤" };

    // 步骤1：检查搜索是否成功
    if (step.objective.startsWith("搜索:")) {
      const searchResult = state.toolResults.find(r => r.toolId === "web_search" && r.status === "succeeded");
      if (!searchResult) return { status: "running" };
      return { status: "completed" };
    }

    // 步骤2：检查网页读取
    if (step.objective.includes("读取关键网页")) {
      const fetchResult = state.toolResults.find(r => r.toolId === "fetch_url");
      if (!fetchResult) return { status: "running" };
      if (fetchResult.status === "succeeded") return { status: "completed" };
      return { status: "failed", failureReason: "网页读取失败" };
    }

    // 步骤3：验证结果完整性
    if (step.objective.includes("验证搜索结果")) {
      const findings = extractFindings(state);
      if (findings.length > 0) return { status: "completed" };
      return { status: "running" };
    }

    return { status: "failed", failureReason: "未知步骤" };
  },

  buildResult(state: SubAgentState): SubAgentPublicResultV1 {
    const findings = extractFindings(state);
    const taskObjective = String(state.ctx.args.objective ?? "搜索信息");

    // 验证结果质量
    const hasSources = findings.every(f => f.source);
    const findingsWithContent = findings.filter(f => f.content.length > 0);

    // 判断完成状态
    let status: "succeeded" | "partial" | "blocked" | "failed" = "succeeded";
    let error: SubAgentPublicResultV1["error"];

    if (findingsWithContent.length === 0) {
      status = "failed";
      error = {
        code: "NO_VALID_FINDINGS",
        message: "未找到有效搜索结果",
        recoverable: true,
      };
    } else if (!hasSources) {
      status = "partial";
      error = {
        code: "MISSING_SOURCES",
        message: "部分结论缺少来源验证",
        recoverable: false,
      };
    } else if (findingsWithContent.length < 3) {
      status = "partial";
      error = {
        code: "INSUFFICIENT_FINDINGS",
        message: "搜索结果数量不足",
        recoverable: true,
      };
    }

    // 只保留最多10条精选 findings
    const selectedFindings = findingsWithContent.slice(0, 10);

    return {
      kind: "subagent_result",
      version: 1,
      taskId: state.ctx.taskId,
      profile: "search",
      status,
      summary: `搜索"${taskObjective}"完成，找到 ${selectedFindings.length} 条结果`,
      findings: selectedFindings,
      artifacts: [], // 搜索代理不产生文件
      completionEvidence: [{
        criterion: "搜索结果已收集并验证",
        satisfied: status === "succeeded",
        evidenceRefs: selectedFindings.map(f => f.source ?? "").filter(Boolean),
      }],
      error,
    };
  },

  hasValidResults(state: SubAgentState): boolean {
    // Search Profile: 有效结果 = 至少一个 finding 内容非空且来源有效
    const findings = extractFindings(state);
    return findings.some(f => f.content.length > 0 && !!f.source);
  },

  extractProgressEvidence(state: SubAgentState): string {
    // Search Profile 进展证据：规范化 URL 集合 + findings 内容摘要 + 完成步骤数
    // 不包含 toolCallsUsed（每次都变，无法反映真实进展）
    const findings = extractFindings(state);
    const urls = findings.map(f => f.source).filter(Boolean).sort();
    const findingsSummary = findings
      .map(f => `${f.title ?? ""}:${f.content.slice(0, 50)}`)
      .sort();
    const completedSteps = state.plan.steps.filter(s => s.status === "completed").length;
    return JSON.stringify({
      urlCount: [...new Set(urls)].length,
      urls: [...new Set(urls)],
      findingsCount: findings.length,
      findingsSummary,
      completedSteps,
    });
  },
};

/** 从工具结果中提取搜索结果 */
function findSearchResults(state: SubAgentState): SearchResult[] {
  const results: SearchResult[] = [];
  for (const tr of state.toolResults) {
    if (tr.toolId === "web_search" && tr.status === "succeeded") {
      try {
        const parsed = JSON.parse(tr.output);
        if (parsed.results && Array.isArray(parsed.results)) {
          results.push(...parsed.results);
        }
      } catch {
        // 解析失败，跳过
      }
    }
  }
  return results;
}

/** 选择最佳 URL 进行深度阅读 */
function selectBestUrl(results: SearchResult[]): string | undefined {
  // 优先选择有摘要的结果
  const withSnippet = results.filter(r => r.snippet && r.snippet.length > 50);
  if (withSnippet.length > 0) return withSnippet[0].url;
  return results[0]?.url;
}

/** 从工具结果中提取 findings */
function extractFindings(state: SubAgentState): SubAgentFinding[] {
  const findings: SubAgentFinding[] = [];
  let id = 1;

  // 从搜索结果提取
  for (const tr of state.toolResults) {
    if (tr.toolId === "web_search" && tr.status === "succeeded") {
      try {
        const parsed = JSON.parse(tr.output);
        if (parsed.results && Array.isArray(parsed.results)) {
          for (const r of parsed.results) {
            findings.push({
              id: `finding_${id++}`,
              title: r.title,
              content: r.snippet || r.content || "",
              source: r.url,
            });
          }
        }
      } catch {
        // 解析失败，跳过
      }
    }

    // 从网页读取结果提取
    if (tr.toolId === "fetch_url" && tr.status === "succeeded") {
      // 提取 URL 和内容摘要
      const urlMatch = tr.output.match(/URL:\s*(https?:\/\/[^\s]+)/);
      const contentStart = tr.output.indexOf("\n\n");
      if (contentStart !== -1) {
        const content = tr.output.slice(contentStart + 2, contentStart + 502); // 取前500字符
        findings.push({
          id: `finding_${id++}`,
          content,
          source: urlMatch?.[1],
        });
      }
    }
  }

  return findings;
}

/** 子代理执行入口（注册到 runner） */
async function runSearchAgent(ctx: SubAgentRunContext): Promise<SubAgentRunOutcome> {
  return runSubAgentGraph(ctx, searchProfile);
}

/** 显式注册 Search Profile。由 registerBuiltInSubAgentProfiles() 调用。 */
export function registerSearchProfile(): void {
  registerSubAgentProfile("search", runSearchAgent);
}
