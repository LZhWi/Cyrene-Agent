// 子代理结果 -> ToolExecutionOutcome 适配层

import type { ToolExecutionOutcome } from "../types";
import type { SubAgentRunOutcome, SubAgentPublicResultV1 } from "./types";
import { serializeSubAgentResult } from "./result-parser";

/**
 * 将子图运行结果映射为 ToolExecutionOutcome。
 * 这是子代理与主 Graph 执行节点之间的唯一适配入口。
 *
 * 映射规则：
 * - invocationStatus 非 completed -> 不可恢复失败
 * - result.status succeeded -> 成功 + 终态
 * - result.status partial -> 成功 + 非终态（主 Agent 可继续）
 * - result.status blocked -> 失败 + 可重试（Action Gate 选 ask_user）
 * - result.status failed -> 失败 + 按 recoverable 决定可重试性
 */
export function toSubAgentToolOutcome(run: SubAgentRunOutcome): ToolExecutionOutcome {
  // 父运行取消或子图崩溃不应到达此处（应直接抛 AbortError），
  // 但防御性处理：无 result 时按不可恢复失败返回
  const result = run.result;

  if (!result) {
    return {
      status: "failed",
      output: serializeSubAgentResult({
        kind: "subagent_result",
        version: 1,
        taskId: "unknown",
        profile: "document",
        status: "failed",
        summary: run.error?.message ?? "子代理运行失败",
        findings: [],
        artifacts: [],
        completionEvidence: [],
        error: {
          code: run.error?.code ?? "SUBAGENT_RUNTIME_FAILED",
          message: run.error?.message ?? "子代理运行失败",
          recoverable: false,
        },
      }),
      errorCode: run.error?.code ?? "SUBAGENT_RUNTIME_FAILED",
      terminal: true,
      retryable: false,
    };
  }

  return mapResultToOutcome(result);
}

function mapResultToOutcome(result: SubAgentPublicResultV1): ToolExecutionOutcome {
  const output = serializeSubAgentResult(result);

  switch (result.status) {
    case "succeeded":
      return {
        status: "succeeded",
        output,
        terminal: true,
        retryable: false,
      };

    case "partial":
      return {
        status: "succeeded",
        output,
        terminal: false,
        retryable: false,
      };

    case "blocked":
      return {
        status: "failed",
        output,
        errorCode: "SUBAGENT_BLOCKED",
        terminal: true,
        retryable: true,
      };

    case "failed":
      return {
        status: "failed",
        output,
        errorCode: result.error?.code ?? "SUBAGENT_TASK_FAILED",
        terminal: true,
        retryable: result.error?.recoverable ?? false,
      };
  }
}
