// Document Agent -- 最小垂直切片
//
// 确定性流水线：write_word -> 验证文件 -> 构建 SubAgentPublicResult
// 第一版不使用 LLM 驱动的子图循环，直接按模板执行。
// 后续需要动态规划时再引入 LLM 决策节点。

import { existsSync, statSync } from "fs";
import { toolRegistry } from "../tool-registry";
import { registerSubAgentProfile } from "./runner";
import type { SubAgentPublicResultV1, SubAgentRunOutcome, SubAgentArtifact, CompletionEvidenceRecord } from "./types";

/** Document Agent 任务参数（由主 Agent Native FC 生成） */
export interface DocumentTaskInput {
  objective: string;
  filename: string;
  title: string;
  paragraphs: string[];
  style?: string;
}

/** 从 write_word 输出中提取文件路径 */
function extractFilePath(output: string): string | undefined {
  const match = output.match(/已生成[：:]\s*(.+)/);
  return match?.[1]?.trim();
}

/**
 * 验证文件：存在 + 是文件 + 大小 > 0 + 修改时间不早于运行开始时间。
 * 文件名复用时通过 mtime 检查防止误判旧文件。
 */
function verifyFile(filePath: string, runStartMs: number): {
  verified: boolean;
  sizeBytes?: number;
  reason?: string;
} {
  if (!existsSync(filePath)) {
    return { verified: false, reason: "文件不存在" };
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    return { verified: false, reason: "路径不是文件" };
  }
  if (stat.size === 0) {
    return { verified: false, reason: "文件大小为零" };
  }
  if (stat.mtimeMs < runStartMs) {
    return { verified: false, reason: "文件修改时间早于本次运行开始时间，可能是旧文件" };
  }
  return { verified: true, sizeBytes: stat.size };
}

/**
 * 运行 Document Agent。
 * 确定性执行：调 write_word -> 验证文件 -> 返回结构化结果。
 */
async function runDocumentAgent(
  taskId: string,
  args: Record<string, unknown>,
): Promise<SubAgentRunOutcome> {
  const input: DocumentTaskInput = {
    objective: String(args.objective ?? ""),
    filename: String(args.filename ?? ""),
    title: String(args.title ?? ""),
    paragraphs: Array.isArray(args.paragraphs) ? args.paragraphs.map(String) : [],
    ...(args.style ? { style: String(args.style) } : {}),
  };

  const writeWordTool = toolRegistry.getById("write_word");
  if (!writeWordTool) {
    return {
      invocationStatus: "crashed",
      error: { code: "TOOL_NOT_FOUND", message: "write_word 工具未注册" },
    };
  }

  const runStartMs = Date.now();

  try {
    // 1. 调用 write_word 生成文档
    const output = await writeWordTool.execute({
      filename: input.filename,
      title: input.title,
      paragraphs: input.paragraphs,
      ...(input.style ? { style: input.style } : {}),
    });

    // 2. 从 write_word 结构化返回中提取文件路径
    const filePath = extractFilePath(output);
    if (!filePath) {
      return {
        invocationStatus: "completed",
        result: buildFailedResult(taskId, "无法从 write_word 输出中提取文件路径", "FILE_PATH_NOT_FOUND", true),
      };
    }

    // 3. 验证文件：存在 + isFile + size>0 + mtime >= runStart
    const verification = verifyFile(filePath, runStartMs);

    // 4. 构建结构化结果
    // Document Profile 是 artifacts_only：不返回 findings，
    // 新闻信息继续来自之前的 web_search 投影。
    const artifacts: SubAgentArtifact[] = [{
      id: "artifact_1",
      name: input.filename,
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

    const result: SubAgentPublicResultV1 = {
      kind: "subagent_result",
      version: 1,
      taskId,
      profile: "document",
      status: verification.verified ? "succeeded" : "failed",
      summary: verification.verified
        ? `文档已生成：${filePath}`
        : `文档验证失败：${verification.reason}`,
      findings: [],  // artifacts_only：新闻来自 web_search 投影
      artifacts,
      completionEvidence,
      ...(verification.verified
        ? {
            primaryArtifact: {
              name: input.filename,
              path: filePath,
              verified: true,
            },
          }
        : {}),
      ...(!verification.verified
        ? {
            error: {
              code: "FILE_VERIFICATION_FAILED",
              message: verification.reason ?? "文件验证失败",
              recoverable: true,
            },
          }
        : {}),
    };

    return { invocationStatus: "completed", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      invocationStatus: "crashed",
      error: { code: "DOCUMENT_AGENT_ERROR", message },
    };
  }
}

function buildFailedResult(
  taskId: string,
  message: string,
  code: string,
  recoverable: boolean,
): SubAgentPublicResultV1 {
  return {
    kind: "subagent_result",
    version: 1,
    taskId,
    profile: "document",
    status: "failed",
    summary: message,
    findings: [],
    artifacts: [],
    completionEvidence: [],
    error: { code, message, recoverable },
  };
}

// 注册 Document Profile
registerSubAgentProfile("document", runDocumentAgent);
