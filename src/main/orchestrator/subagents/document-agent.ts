// Document Agent -- 通过通用子代理 Graph 骨架运行
//
// Profile 配置：模板计划 + 确定性决策（不调用 LLM）
// 模板步骤：验证输入 -> 调用 write_word -> 验证 artifact -> 构建结果

import { existsSync, statSync } from "fs";
import { registerSubAgentProfile } from "./runner";
import { runSubAgentGraph, buildFailedResult } from "./graph";
import type {
  SubAgentRunContext,
  SubAgentRunOutcome,
  SubAgentState,
  SubAgentProfileConfig,
  SubAgentPlan,
  SubAgentPublicResultV1,
  SubAgentArtifact,
  CompletionEvidenceRecord,
  SubAgentDecision,
} from "./types";
import type { PlanStep, StepVerificationResult } from "../task-plan";
import { generatePlanId, generateStepId } from "../task-plan";

/** Document Agent 工具白名单 */
const DOCUMENT_ALLOWED_TOOLS = new Set([
  "write_word", "write_excel", "write_pdf", "write_markdown",
  "write_file", "read_file", "list_dir",
]);

/** 从 write_word 输出中提取文件路径 */
function extractFilePath(output: string): string | undefined {
  const match = output.match(/已生成[：:]\s*(.+)/);
  return match?.[1]?.trim();
}

/** 验证文件：存在 + isFile + size>0 + mtime >= runStart - 2s */
function verifyFile(filePath: string, runStartMs: number): {
  verified: boolean; sizeBytes?: number; reason?: string;
} {
  if (!existsSync(filePath)) return { verified: false, reason: "文件不存在" };
  const stat = statSync(filePath);
  if (!stat.isFile()) return { verified: false, reason: "路径不是文件" };
  if (stat.size === 0) return { verified: false, reason: "文件大小为零" };
  if (stat.mtimeMs < runStartMs - 2000) return { verified: false, reason: "文件修改时间早于本次运行开始时间" };
  return { verified: true, sizeBytes: stat.size };
}

/** Document Profile 配置 */
const documentProfile: SubAgentProfileConfig = {
  id: "document",
  allowedTools: DOCUMENT_ALLOWED_TOOLS,
  budget: { maxSteps: 5, maxToolCalls: 10, timeoutMs: 60_000, maxReplans: 1 },

  createInitialPlan(ctx: SubAgentRunContext): SubAgentPlan {
    const now = Date.now();
    return {
      id: generatePlanId(),
      goal: String(ctx.args.objective ?? "生成文档"),
      steps: [
        {
          id: generateStepId(),
          objective: "调用 write_word 生成文档",
          status: "pending",
          completionPolicy: { allOf: [{ kind: "tool_succeeded", capabilityId: "write_word" }] },
          toolCallCount: 0, retryCount: 0,
        },
        {
          id: generateStepId(),
          objective: "验证文件已生成",
          status: "pending",
          completionPolicy: { allOf: [{ kind: "tool_succeeded", capabilityId: "write_word" }] },
          toolCallCount: 0, retryCount: 0,
        },
      ],
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
  },

  decide(state: SubAgentState): SubAgentDecision {
    const step = state.plan.steps.find(s => s.id === state.currentStepId);
    if (!step) return { action: "fail", reason: "无当前步骤", code: "NO_STEP", recoverable: false };

    // 步骤 1：调用 write_word
    if (step.objective.includes("调用 write_word")) {
      const args = state.ctx.args;
      return {
        action: "call_tool",
        toolId: "write_word",
        args: {
          filename: String(args.filename ?? ""),
          title: String(args.title ?? ""),
          paragraphs: Array.isArray(args.paragraphs) ? args.paragraphs.map(String) : [],
          ...(args.style ? { style: String(args.style) } : {}),
        },
      };
    }

    // 步骤 2：验证文件（不需要调用工具）
    return { action: "skip" };
  },

  verifyStep(state: SubAgentState): StepVerificationResult {
    const step = state.plan.steps.find(s => s.id === state.currentStepId);
    if (!step) return { status: "failed", failureReason: "无当前步骤" };

    // 步骤 1：检查 write_word 是否成功调用
    if (step.objective.includes("调用 write_word")) {
      const writeResult = state.toolResults.find(r => r.toolId === "write_word");
      if (!writeResult) return { status: "running" };
      if (writeResult.status !== "succeeded") return { status: "failed", failureReason: "write_word 调用失败" };
      return { status: "completed" };
    }

    // 步骤 2：验证文件
    if (step.objective.includes("验证文件")) {
      const writeResult = state.toolResults.find(r => r.toolId === "write_word");
      if (!writeResult) return { status: "failed", failureReason: "未找到 write_word 结果" };
      const filePath = extractFilePath(writeResult.output);
      if (!filePath) return { status: "failed", failureReason: "无法提取文件路径" };
      const verification = verifyFile(filePath, state.budgetUsage.startedAt);
      if (verification.verified) return { status: "completed" };
      return { status: "failed", failureReason: verification.reason ?? "文件验证失败" };
    }

    return { status: "failed", failureReason: "未知步骤" };
  },

  buildResult(state: SubAgentState): SubAgentPublicResultV1 {
    const writeResult = state.toolResults.find(r => r.toolId === "write_word");
    const args = state.ctx.args;
    const filename = String(args.filename ?? "");

    if (!writeResult || writeResult.status !== "succeeded") {
      return buildFailedResult(state.ctx.taskId, "document", "文档生成失败", "WRITE_WORD_FAILED", true);
    }

    const filePath = extractFilePath(writeResult.output);
    if (!filePath) {
      return buildFailedResult(state.ctx.taskId, "document", "无法提取文件路径", "FILE_PATH_NOT_FOUND", true);
    }

    const verification = verifyFile(filePath, state.budgetUsage.startedAt);

    const artifacts: SubAgentArtifact[] = [{
      id: "artifact_1",
      name: filename,
      path: filePath,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: verification.sizeBytes,
      verified: verification.verified,
    }];

    const completionEvidence: CompletionEvidenceRecord[] = [{
      criterion: "Word 文档已成功生成并验证",
      satisfied: verification.verified,
      evidenceRefs: verification.verified ? [filePath] : [],
    }];

    return {
      kind: "subagent_result",
      version: 1,
      taskId: state.ctx.taskId,
      profile: "document",
      status: verification.verified ? "succeeded" : "failed",
      summary: verification.verified ? `文档已生成：${filePath}` : `文档验证失败：${verification.reason}`,
      findings: [], // artifacts_only
      artifacts,
      completionEvidence,
      ...(verification.verified
        ? { primaryArtifact: { name: filename, path: filePath, verified: true } }
        : { error: { code: "FILE_VERIFICATION_FAILED", message: verification.reason ?? "文件验证失败", recoverable: true } }),
    };
  },

  hasValidResults(state: SubAgentState): boolean {
    // Document Profile: 有效结果 = write_word 成功且文件路径可提取
    const writeResult = state.toolResults.find(r => r.toolId === "write_word" && r.status === "succeeded");
    if (!writeResult) return false;
    const filePath = extractFilePath(writeResult.output);
    return !!filePath;
  },

  extractProgressEvidence(state: SubAgentState): string {
    // Document Profile 进展证据：工具调用次数 + 文件路径 + 完成步骤数
    const writeResult = state.toolResults.find(r => r.toolId === "write_word" && r.status === "succeeded");
    const filePath = writeResult ? extractFilePath(writeResult.output) : undefined;
    const completedSteps = state.plan.steps.filter(s => s.status === "completed").length;
    return JSON.stringify({
      toolCalls: state.budgetUsage.toolCallsUsed,
      hasFile: !!filePath,
      filePath: filePath ?? "",
      completedSteps,
    });
  },
};

/** 子代理执行入口（注册到 runner） */
async function runDocumentAgent(ctx: SubAgentRunContext): Promise<SubAgentRunOutcome> {
  return runSubAgentGraph(ctx, documentProfile);
}

/** 显式注册 Document Profile。由 registerBuiltInSubAgentProfiles() 调用。 */
export function registerDocumentProfile(): void {
  registerSubAgentProfile("document", runDocumentAgent);
}
