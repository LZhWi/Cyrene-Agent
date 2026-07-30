/**
 * Code Run 最终状态裁决
 *
 * 事实优先级：
 * host cancelled / interrupted
 * > VerificationSummary
 * > MutationEvidence
 * > Cline finishReason
 * > Cline 自然语言总结
 *
 * 纯函数，无副作用。
 */

import type { CodeRunFacts } from "./cline-result-adapter";
import type { MutationEvidence } from "./mutation-collector";
import type { VerificationSummary } from "./verification-runner";

export type CodeRunFinalStatus =
  | "completed_verified"
  | "completed_no_changes"
  | "failed_verification"
  | "unverified"
  | "approval_required"
  | "cancelled"
  | "interrupted"
  | "failed";

export interface CodeVerificationCard {
  runId: string;
  status: CodeRunFinalStatus;
  workspaceRoot: string;

  mutations: {
    created: string[];
    modified: string[];
    deleted: string[];
    touchedPreExisting: string[];
  };

  verification: {
    status: VerificationSummary["status"];
    steps: Array<{
      type: string;
      passed: boolean;
      skipped: boolean;
      cwd: string;
      exitCode: number | null;
      durationMs: number;
      errorCode?: string;
    }>;
  };

  warnings: string[];
}

export interface FinalStateInput {
  codeRunFacts: CodeRunFacts;
  mutationEvidence: MutationEvidence;
  verificationSummary: VerificationSummary | null;
}

export function resolveCodeRunFinalState(input: FinalStateInput): {
  status: CodeRunFinalStatus;
  card: CodeVerificationCard;
} {
  const { codeRunFacts, mutationEvidence, verificationSummary } = input;

  // 1. 宿主取消
  if (codeRunFacts.hostCancelled) {
    return {
      status: "cancelled",
      card: buildCard(codeRunFacts, mutationEvidence, verificationSummary, "cancelled"),
    };
  }

  // 2. 宿主中断
  if (codeRunFacts.hostInterrupted) {
    return {
      status: "interrupted",
      card: buildCard(codeRunFacts, mutationEvidence, verificationSummary, "interrupted"),
    };
  }

  // 3. 验证需要审批
  if (verificationSummary?.status === "approval_required") {
    return {
      status: "approval_required",
      card: buildCard(codeRunFacts, mutationEvidence, verificationSummary, "approval_required"),
    };
  }

  // 4. 真实文件变更检测
  const hasRealChanges = hasMutationChanges(mutationEvidence);

  // 5. 有修改 + 验证通过
  if (hasRealChanges && verificationSummary?.status === "passed") {
    return {
      status: "completed_verified",
      card: buildCard(codeRunFacts, mutationEvidence, verificationSummary, "completed_verified"),
    };
  }

  // 6. 有修改 + 验证失败
  if (hasRealChanges && verificationSummary?.status === "failed") {
    return {
      status: "failed_verification",
      card: buildCard(codeRunFacts, mutationEvidence, verificationSummary, "failed_verification"),
    };
  }

  // 7. 有修改 + 无计划/未运行
  if (hasRealChanges) {
    const planStatus = verificationSummary?.status ?? "not_run";
    if (planStatus === "plan_not_found" || planStatus === "not_run") {
      return {
        status: "unverified",
        card: buildCard(codeRunFacts, mutationEvidence, verificationSummary, "unverified"),
      };
    }
  }

  // 8. 无修改 + Cline 正常完成
  if (!hasRealChanges && codeRunFacts.status === "completed") {
    return {
      status: "completed_no_changes",
      card: buildCard(codeRunFacts, mutationEvidence, verificationSummary, "completed_no_changes"),
    };
  }

  // 9. Cline 错误且无更高优先级事实
  return {
    status: "failed",
    card: buildCard(codeRunFacts, mutationEvidence, verificationSummary, "failed"),
  };
}

function hasMutationChanges(evidence: MutationEvidence): boolean {
  return evidence.createdFiles.length > 0
    || evidence.modifiedFiles.length > 0
    || evidence.deletedFiles.length > 0;
}

function buildCard(
  codeRunFacts: CodeRunFacts,
  mutationEvidence: MutationEvidence,
  verificationSummary: VerificationSummary | null,
  finalStatus: CodeRunFinalStatus,
): CodeVerificationCard {
  const warnings: string[] = [];
  if (mutationEvidence.rejectedOutsideWorkspacePaths.length > 0) {
    warnings.push(`${mutationEvidence.rejectedOutsideWorkspacePaths.length} 个工作区外路径被拒绝`);
  }
  if (mutationEvidence.ignoredPaths.length > 0) {
    warnings.push(`${mutationEvidence.ignoredPaths.length} 个路径在忽略规则中`);
  }

  return {
    runId: codeRunFacts.runId,
    status: finalStatus,
    workspaceRoot: mutationEvidence.preExistingChanges.length > 0
      ? "(从 mutation 推断)"
      : "(未知)",
    mutations: {
      created: mutationEvidence.createdFiles,
      modified: mutationEvidence.modifiedFiles,
      deleted: mutationEvidence.deletedFiles,
      touchedPreExisting: mutationEvidence.touchedPreExistingFiles,
    },
    verification: {
      status: verificationSummary?.status ?? "not_run",
      steps: verificationSummary?.steps.map(s => ({
        type: s.type,
        passed: s.passed,
        skipped: s.skipped,
        cwd: s.cwd,
        exitCode: s.exitCode,
        durationMs: s.durationMs,
        errorCode: s.errorCode,
      })) ?? [],
    },
    warnings,
  };
}