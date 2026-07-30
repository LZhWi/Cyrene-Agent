export type CodeRunStatus =
  | "queued"
  | "running"
  | "waiting_for_user"
  | "verifying"
  | "approval_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface CodeRunRecord {
  runId: string;
  chatSessionId: string;
  clineSessionId: string;
  status: CodeRunStatus;
  startedAt: number;
  finishedAt?: number;
  errorCode?: string;
}

export interface VerificationApproval {
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
  status: "pending" | "approved" | "rejected" | "cancelled";
  createdAt: number;
  resolvedAt?: number;
}

export interface CodeVerificationCard {
  runId: string;
  status:
    | "completed_verified"
    | "completed_no_changes"
    | "failed_verification"
    | "unverified"
    | "approval_required"
    | "cancelled"
    | "interrupted"
    | "failed";
  workspaceRoot: string;
  mutations: {
    created: string[];
    modified: string[];
    deleted: string[];
    touchedPreExisting: string[];
  };
  verification: {
    status: "passed" | "failed" | "not_run" | "approval_required" | "plan_not_found";
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

export interface CodeRunViewModel {
  run: CodeRunRecord | null;
  approval: VerificationApproval | null;
  card: CodeVerificationCard | null;
}

export interface CodeRunApi {
  getRun: (runId: string) => Promise<CodeRunRecord | null>;
  getActiveRun: (params: { chatSessionId?: string; clineSessionId?: string }) => Promise<CodeRunRecord | null>;
  listRuns: (chatSessionId?: string) => Promise<CodeRunRecord[]>;
  getPendingApprovals: (params: { chatSessionId?: string; runId?: string }) => Promise<VerificationApproval[]>;
  approveVerification: (approvalId: string) => Promise<{
    ok: boolean;
    approval?: VerificationApproval;
    error?: string;
  }>;
  rejectVerification: (approvalId: string) => Promise<{
    ok: boolean;
    approval?: VerificationApproval;
    error?: string;
  }>;
}

export function createCodeRunViewModel(): CodeRunViewModel {
  return { run: null, approval: null, card: null };
}

export function applyCodeRunEvent(state: CodeRunViewModel, rawEvent: unknown): CodeRunViewModel {
  if (!rawEvent || typeof rawEvent !== "object") return state;
  const event = rawEvent as { type?: string; name?: string; value?: unknown; payload?: unknown };
  const type = event.type === "CUSTOM" ? event.name : event.type;
  const payload = event.type === "CUSTOM" ? event.value : event.payload;

  if (type === "code_verification_approval" && payload && typeof payload === "object") {
    return { ...state, approval: payload as VerificationApproval };
  }
  if (type === "code_verification_card" && payload && typeof payload === "object") {
    return {
      ...state,
      approval: null,
      card: payload as CodeVerificationCard,
    };
  }
  return state;
}

export async function restoreCodeRunViewModel(
  state: CodeRunViewModel,
  api: CodeRunApi,
  chatSessionId: string,
): Promise<CodeRunViewModel> {
  const run = await api.getActiveRun({ chatSessionId });
  const approvals = await api.getPendingApprovals(
    run ? { runId: run.runId } : { chatSessionId },
  );
  return {
    run,
    approval: approvals[0] ?? null,
    card: run && state.card?.runId !== run.runId ? null : state.card,
  };
}
