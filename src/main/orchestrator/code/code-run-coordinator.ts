/**
 * CodeRunCoordinator - Session 级并发控制
 *
 * 每个 Cline Session 同一时间只允许一个 active turn。
 * 拒绝并发请求并返回明确错误。
 */

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

class CodeRunCoordinator {
  /** runId -> record */
  private runs: Map<string, CodeRunRecord> = new Map();
  /** clineSessionId -> 当前活跃 runId */
  private activeRunsBySession: Map<string, string> = new Map();
  /** chatSessionId -> 当前活跃 runId（Cline Session 尚未创建时也可防并发） */
  private activeRunsByChatSession: Map<string, string> = new Map();

  /** 创建新 run 记录 */
  createRun(runId: string, chatSessionId: string, clineSessionId: string): CodeRunRecord {
    const record: CodeRunRecord = {
      runId,
      chatSessionId,
      clineSessionId,
      status: "queued",
      startedAt: Date.now(),
    };
    this.runs.set(runId, record);
    return record;
  }

  /** 激活 run（必须在后台 turn 开始前调用） */
  activate(runId: string): boolean {
    const record = this.runs.get(runId);
    if (!record) return false;

    // 同一 Session 已有活跃 run -> 拒绝
    const existingChatRun = this.activeRunsByChatSession.get(record.chatSessionId);
    const existingSessionRun = record.clineSessionId
      ? this.activeRunsBySession.get(record.clineSessionId)
      : undefined;
    if (
      (existingChatRun && existingChatRun !== runId)
      || (existingSessionRun && existingSessionRun !== runId)
    ) {
      return false;
    }

    record.status = "running";
    this.activeRunsByChatSession.set(record.chatSessionId, runId);
    if (record.clineSessionId) {
      this.activeRunsBySession.set(record.clineSessionId, runId);
    }
    return true;
  }

  /** Cline Session 创建完成后，原子更新 Run 与活跃映射。 */
  bindClineSession(runId: string, clineSessionId: string): boolean {
    const record = this.runs.get(runId);
    if (!record || !clineSessionId || this.isTerminal(record.status)) return false;
    const existing = this.activeRunsBySession.get(clineSessionId);
    if (existing && existing !== runId) return false;

    if (record.clineSessionId) {
      const oldActive = this.activeRunsBySession.get(record.clineSessionId);
      if (oldActive === runId) this.activeRunsBySession.delete(record.clineSessionId);
    }
    record.clineSessionId = clineSessionId;
    this.activeRunsBySession.set(clineSessionId, runId);
    return true;
  }

  /** 标记 run 进入 waiting_for_user 状态 */
  setWaitingForUser(runId: string): void {
    const record = this.runs.get(runId);
    if (record && record.status === "running") record.status = "waiting_for_user";
  }

  /** Ask resolve/reject 后把仍活跃的 run 交还给执行阶段。 */
  setRunning(runId: string): void {
    const record = this.runs.get(runId);
    if (record && record.status === "waiting_for_user") record.status = "running";
  }

  /** 标记 run 进入 verifying 状态 */
  setVerifying(runId: string): void {
    const record = this.runs.get(runId);
    if (record && !this.isTerminal(record.status)) record.status = "verifying";
  }

  /** 标记 run 正在等待验证审批。 */
  setApprovalRequired(runId: string): void {
    const record = this.runs.get(runId);
    if (record && !this.isTerminal(record.status)) record.status = "approval_required";
  }

  /** 标记 run 完成 */
  complete(runId: string, status: "completed" | "failed" | "cancelled" | "interrupted", errorCode?: string): void {
    const record = this.runs.get(runId);
    if (!record) return;
    if (this.isTerminal(record.status)) return;
    record.status = status;
    record.finishedAt = Date.now();
    if (errorCode) record.errorCode = errorCode;
    // 从活跃 map 移除
    const activeId = this.activeRunsBySession.get(record.clineSessionId);
    if (activeId === runId) {
      this.activeRunsBySession.delete(record.clineSessionId);
    }
    const activeChatId = this.activeRunsByChatSession.get(record.chatSessionId);
    if (activeChatId === runId) {
      this.activeRunsByChatSession.delete(record.chatSessionId);
    }
  }

  /** 获取 run 记录 */
  getRun(runId: string): CodeRunRecord | undefined {
    return this.runs.get(runId);
  }

  /** 根据 chatSessionId 获取活跃 run */
  getActiveRunByChatSession(chatSessionId: string): CodeRunRecord | undefined {
    const runId = this.activeRunsByChatSession.get(chatSessionId);
    if (!runId) return undefined;
    const run = this.runs.get(runId);
    return run && this.isActive(run.runId) ? run : undefined;
  }

  /** 根据 clineSessionId 获取活跃 run */
  getActiveRunByClineSession(clineSessionId: string): CodeRunRecord | undefined {
    const runId = this.activeRunsBySession.get(clineSessionId);
    if (!runId) return undefined;
    return this.runs.get(runId);
  }

  /** 检查 Session 是否有活跃 run */
  isSessionBusy(clineSessionId: string): boolean {
    return this.activeRunsBySession.has(clineSessionId);
  }

  /** 检查 runId 是否正在运行 */
  isActive(runId: string): boolean {
    const record = this.runs.get(runId);
    if (!record) return false;
    return record.status === "running"
      || record.status === "waiting_for_user"
      || record.status === "verifying"
      || record.status === "approval_required";
  }

  /** 兼容旧调用名。 */
  isRunning(runId: string): boolean {
    return this.isActive(runId);
  }

  isTerminal(status: CodeRunStatus): boolean {
    return status === "completed"
      || status === "failed"
      || status === "cancelled"
      || status === "interrupted";
  }

  /** 列出所有 runs */
  listRuns(chatSessionId?: string): CodeRunRecord[] {
    const all = Array.from(this.runs.values());
    if (!chatSessionId) return all;
    return all.filter(r => r.chatSessionId === chatSessionId);
  }

  /** 重置（测试用） */
  reset(): void {
    this.runs.clear();
    this.activeRunsBySession.clear();
    this.activeRunsByChatSession.clear();
  }
}

export const codeRunCoordinator = new CodeRunCoordinator();
