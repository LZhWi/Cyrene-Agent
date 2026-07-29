/**
 * Cline 适配层 - 集成入口
 *
 * 在 index.ts 启动时调用 registerClineCodingAgent()，
 * 注入模型配置和 Feature Flag。
 */

import { registerDelegateCodingTool } from "./tool-registration";
import type { CodingAgentResult } from "./types";

/**
 * 注册 Cline Coding Agent 工具。
 * 由 index.ts 在工具注册阶段调用。
 */
export function registerClineCodingAgent(
  modelConfigGetter: () => { providerId: string; modelId: string; apiKey: string; baseUrl: string } | null,
  enabled: boolean,
): void {
  registerDelegateCodingTool(modelConfigGetter, enabled);
}

/**
 * 从 CodingAgentResult 提取 CodeVerificationState 更新。
 *
 * 规则：
 * - changedFiles 非空 -> mutationRevision++
 * - Cline 内部 verification 不直接更新 verifiedRevision
 * - status=completed 且 changedFiles 非空 -> status=pending
 * - status=failed/cancelled 且 partialChanges -> status=pending
 * - status=completed 且 changedFiles 空 -> 不修改
 */
export function extractVerificationUpdate(
  result: CodingAgentResult,
  currentMutationRevision: number,
): {
  mutationRevision?: number;
  changedFiles?: string[];
  status?: "pending";
} {
  // 有变更文件（无论成功/失败/取消）
  if (result.changedFiles.length > 0 || result.partialChanges) {
    return {
      mutationRevision: currentMutationRevision + 1,
      changedFiles: result.changedFiles,
      status: "pending" as const,
    };
  }

  // 无变更
  return {};
}
