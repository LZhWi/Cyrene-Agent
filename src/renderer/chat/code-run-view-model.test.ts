import { describe, expect, it, vi } from "vitest";
import {
  applyCodeRunEvent,
  createCodeRunViewModel,
  restoreCodeRunViewModel,
  type CodeRunApi,
  type CodeRunRecord,
  type VerificationApproval,
} from "./code-run-view-model";

const run: CodeRunRecord = {
  runId: "run-1",
  chatSessionId: "chat-1",
  clineSessionId: "cline-1",
  status: "approval_required",
  startedAt: 1,
};

const approval: VerificationApproval = {
  approvalId: "approval-1",
  runId: "run-1",
  chatSessionId: "chat-1",
  clineSessionId: "cline-1",
  stepId: "step-1",
  trust: "workspace_script",
  executable: "npm",
  args: ["test"],
  cwd: "C:\\repo",
  source: "package_script",
  status: "pending",
  createdAt: 1,
};

describe("CodeRunViewModel", () => {
  it("消费 approval 与 deterministic card 事件", () => {
    const withApproval = applyCodeRunEvent(createCodeRunViewModel(), {
      type: "code_verification_approval",
      payload: approval,
    });
    expect(withApproval.approval).toEqual(approval);

    const withCard = applyCodeRunEvent(withApproval, {
      type: "code_verification_card",
      payload: {
        runId: "run-1",
        status: "completed_verified",
        workspaceRoot: "C:\\repo",
        mutations: { created: [], modified: ["a.ts"], deleted: [], touchedPreExisting: [] },
        verification: { status: "passed", steps: [] },
        warnings: [],
      },
    });
    expect(withCard.approval).toBeNull();
    expect(withCard.card?.status).toBe("completed_verified");
  });

  it.each(["running", "waiting_for_user", "verifying", "approval_required"] as const)(
    "Renderer 刷新后恢复 %s",
    async (status) => {
      const active = { ...run, status };
      const api = {
        getActiveRun: vi.fn().mockResolvedValue(active),
        getPendingApprovals: vi.fn().mockResolvedValue(status === "approval_required" ? [approval] : []),
      } as unknown as CodeRunApi;

      const restored = await restoreCodeRunViewModel(createCodeRunViewModel(), api, "chat-1");

      expect(restored.run?.status).toBe(status);
      expect(restored.approval).toEqual(status === "approval_required" ? approval : null);
      expect(api.getActiveRun).toHaveBeenCalledWith({ chatSessionId: "chat-1" });
    },
  );
});
