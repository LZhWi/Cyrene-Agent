// Document Agent -- 最小垂直切片
//
// 确定性流水线：write_word -> 验证文件 -> 构建 SubAgentPublicResult
// 第一版不使用 LLM 驱动的子图循环，直接按模板执行。
// 后续需要动态规划时再引入 LLM 决策节点。

import { existsSync, statSync } from "fs";
import { toolRegistry } from "../tool-registry";
import type { SubAgentPublicResultV1, SubAgentRunOutcome, SubAgentFinding, SubAgentArtifact, CompletionEvidenceRecord } from "./types";

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
 * 运行 Document Agent。
 * 确定性执行：调 write_word -> 验证文件 -> 返回结构化结果。
 */
export async function runDocumentAgent(
  taskId: string,
  input: DocumentTaskInput,
): Promise<SubAgentRunOutcome> {
  const writeWordTool = toolRegistry.getById("write_word");
  if (!writeWordTool) {
    return {
      invocationStatus: "crashed",
      error: { code: "TOOL_NOT_FOUND", message: "write_word 工具未注册" },
    };
  }

  try {
    // 1. 调用 write_word 生成文档
    const output = await writeWordTool.execute({
      filename: input.filename,
      title: input.title,
      paragraphs: input.paragraphs,
      ...(input.style ? { style: input.style } : {}),
    });

    // 2. 从输出提取文件路径
    const filePath = extractFilePath(output);
    if (!filePath) {
      return {
        invocationStatus: "completed",
        result: buildFailedResult(
          taskId,
          "无法从 write_word 输出中提取文件路径",
          "FILE_PATH_NOT_FOUND",
          true,
        ),
      };
    }

    // 3. 验证文件存在
    const fileExists = existsSync(filePath);
    const stat = fileExists ? statSync(filePath) : undefined;

    // 4. 构建结构化结果
    const artifacts: SubAgentArtifact[] = [{
      id: "artifact_1",
      name: input.filename,
      path: filePath,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: stat?.size,
      verified: fileExists,
    }];

    const completionEvidence: CompletionEvidenceRecord[] = [{
      criterion: "Word 文档已成功生成",
      satisfied: fileExists,
      evidenceRefs: fileExists ? [filePath] : [],
    }];

    // findings：把段落内容作为新闻信息传给 Soul
    const findings: SubAgentFinding[] = input.paragraphs.slice(0, 10).map((content, i) => ({
      id: `finding_${i + 1}`,
      content: content.length > 500 ? content.slice(0, 500) : content,
    }));

    const result: SubAgentPublicResultV1 = {
      kind: "subagent_result",
      version: 1,
      taskId,
      profile: "document",
      status: fileExists ? "succeeded" : "failed",
      summary: fileExists
        ? `文档已生成：${filePath}`
        : "文档生成失败：文件未找到",
      findings,
      artifacts,
      completionEvidence,
      ...(fileExists
        ? {
            primaryArtifact: {
              name: input.filename,
              path: filePath,
              verified: true,
            },
          }
        : {}),
      ...(!fileExists
        ? {
            error: {
              code: "FILE_NOT_FOUND",
              message: "生成的文件不存在",
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
