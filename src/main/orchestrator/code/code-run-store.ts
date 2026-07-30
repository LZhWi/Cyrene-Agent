/**
 * CodeRunStore - 应用级 Code 运行状态存储
 *
 * 职责：
 * - 存储 VerificationPendingApproval
 * - 把 Renderer 的 Run 查询委托给唯一的 CodeRunCoordinator
 *
 * Renderer 刷新或重新进入会话时，可通过 IPC 恢复：
 * - running / waiting_for_user / verifying / approval_required
 */

import { codeRunCoordinator } from "./code-run-coordinator";
import type { CodeRunRecord } from "./code-run-coordinator";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface VerificationPendingApproval {
  approvalId: string;
  runId: string;
  chatSessionId: string;
  clineSessionId: string;

  stepId: string;
  trust: "workspace_script" | "custom";

  executable: string;
  args: string[];
  cwd: string;
  source: string;

  status: ApprovalStatus;
  createdAt: number;
  resolvedAt?: number;
}

class CodeRunStore {
  private approvals: Map<string, VerificationPendingApproval> = new Map();
  private approvalDecisions: Map<string, {
    resolve: (approved: boolean) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private approvalCounter = 0;

  // ── Run 状态查询 ──────────────────────────────────────

  getRun(runId: string): CodeRunRecord | undefined {
    return codeRunCoordinator.getRun(runId);
  }

  getActiveRunByChatSession(chatSessionId: string): CodeRunRecord | undefined {
    return codeRunCoordinator.getActiveRunByChatSession(chatSessionId);
  }

  getActiveRunByClineSession(clineSessionId: string): CodeRunRecord | undefined {
    return codeRunCoordinator.getActiveRunByClineSession(clineSessionId);
  }

  listRuns(chatSessionId?: string): CodeRunRecord[] {
    return codeRunCoordinator.listRuns(chatSessionId);
  }

  // ── Approval 管理 ──────────────────────────────────────

  createApproval(input: {
    runId: string;
    chatSessionId: string;
    clineSessionId: string;
    stepId: string;
    trust: "workspace_script" | "custom";
    executable: string;
    args: string[];
    cwd: string;
    source: string;
  }): VerificationPendingApproval {
    const approval: VerificationPendingApproval = {
      approvalId: `approval-${++this.approvalCounter}-${Date.now()}`,
      runId: input.runId,
      chatSessionId: input.chatSessionId,
      clineSessionId: input.clineSessionId,
      stepId: input.stepId,
      trust: input.trust,
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      source: input.source,
      status: "pending",
      createdAt: Date.now(),
    };
    this.approvals.set(approval.approvalId, approval);
    return approval;
  }

  /** 创建可跨 IPC 等待的审批；Store 只持久化审批状态，不复制 Run/Session 状态。 */
  requestApproval(input: Parameters<CodeRunStore["createApproval"]>[0]): {
    approval: VerificationPendingApproval;
    decision: Promise<boolean>;
  } {
    const approval = this.createApproval(input);
    const decision = new Promise<boolean>((resolve, reject) => {
      this.approvalDecisions.set(approval.approvalId, { resolve, reject });
    });
    return { approval, decision };
  }

  getApproval(approvalId: string): VerificationPendingApproval | undefined {
    return this.approvals.get(approvalId);
  }

  getPendingApprovalsByRun(runId: string): VerificationPendingApproval[] {
    return Array.from(this.approvals.values()).filter(
      a => a.runId === runId && a.status === "pending",
    );
  }

  getPendingApprovalsByChatSession(chatSessionId: string): VerificationPendingApproval[] {
    return Array.from(this.approvals.values()).filter(
      a => a.chatSessionId === chatSessionId && a.status === "pending",
    );
  }

  /** 批准审批（幂等） */
  approve(approvalId: string): VerificationPendingApproval | undefined {
    const a = this.approvals.get(approvalId);
    if (!a) return undefined;
    if (a.status === "approved") return a; // 幂等
    if (a.status === "rejected" || a.status === "cancelled") return a; // 终态不可改
    a.status = "approved";
    a.resolvedAt = Date.now();
    this.approvalDecisions.get(approvalId)?.resolve(true);
    this.approvalDecisions.delete(approvalId);
    return a;
  }

  /** 拒绝审批 */
  reject(approvalId: string): VerificationPendingApproval | undefined {
    const a = this.approvals.get(approvalId);
    if (!a) return undefined;
    if (a.status === "rejected") return a; // 幂等
    if (a.status === "approved" || a.status === "cancelled") return a; // 终态不可改
    a.status = "rejected";
    a.resolvedAt = Date.now();
    this.approvalDecisions.get(approvalId)?.resolve(false);
    this.approvalDecisions.delete(approvalId);
    return a;
  }

  /** 应用退出清理 */
  cleanup(): void {
    for (const a of this.approvals.values()) {
      if (a.status === "pending") {
        a.status = "cancelled";
        a.resolvedAt = Date.now();
        this.approvalDecisions.get(a.approvalId)?.reject(
          new Error("VERIFICATION_APPROVAL_CANCELLED:shutdown"),
        );
        this.approvalDecisions.delete(a.approvalId);
      }
    }
  }

  reset(): void {
    for (const pending of this.approvalDecisions.values()) {
      pending.resolve(false);
    }
    this.approvalDecisions.clear();
    this.approvals.clear();
    this.approvalCounter = 0;
  }
}

export const codeRunStore = new CodeRunStore();
