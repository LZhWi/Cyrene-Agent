/**
 * CodeRunWorker - 应用级长期任务管理器
 *
 * 不是 Node worker_threads，是主进程内的异步任务协调器。
 *
 * 职责：
 * - 后台 Promise rejection 捕获
 * - CodeRunRecord 状态持久化（基于 CodeRunCoordinator）
 * - queued/running/waiting_for_user/completed/failed/cancelled/interrupted 状态
 * - Renderer 刷新后可读取状态
 * - WebContents 销毁不会终止 Cline turn
 * - 同 Session 仅一个 active turn
 * - 应用退出时统一清理
 */

import { codeRunCoordinator } from "./code-run-coordinator";
import { rejectAllAsksOnShutdown } from "./code-ask-bridge";
import { codeRunStore } from "./code-run-store";

class CodeRunWorker {
  private cleanupHandlers: Array<() => void> = [];

  /**
   * 提交 Cline turn 作为后台任务。
   * 返回 Promise，但调用方不必须 await：
   * - await：等待 turn 完成
   * - 不 await：让 turn 在后台运行
   *
   * 后台 Promise 的 rejection 会被捕获并记录到 CodeRunRecord。
   */
  async submit<T>(
    runId: string,
    chatSessionId: string,
    clineSessionId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    codeRunCoordinator.createRun(runId, chatSessionId, clineSessionId);

    // 尝试激活（同一 session 已有 active run 时返回 false）
    if (!codeRunCoordinator.activate(runId)) {
      codeRunCoordinator.complete(runId, "failed", "SESSION_BUSY");
      throw new Error("SESSION_BUSY");
    }

    try {
      const result = await task();
      codeRunCoordinator.complete(runId, "completed");
      return result;
    } catch (err) {
      // 区分 host 取消 vs 异常
      const errMsg = (err as Error).message ?? String(err);
      if (errMsg.startsWith("ASK_CANCELLED:user")) {
        codeRunCoordinator.complete(runId, "cancelled", errMsg);
      } else if (errMsg.startsWith("ASK_CANCELLED:shutdown")) {
        codeRunCoordinator.complete(runId, "interrupted", errMsg);
      } else {
        codeRunCoordinator.complete(runId, "failed", errMsg);
      }
      throw err;
    }
  }

  /** 注册应用退出时的清理 handler */
  registerShutdownHandler(): void {
    const handler = () => this.cleanup();
    this.cleanupHandlers.push(handler);
  }

  /** 应用退出清理：reject 所有 Ask，标记所有 active run 为 interrupted，cancel 所有 pending approval */
  cleanup(): void {
    const count = rejectAllAsksOnShutdown();
    // 标记所有未完成的 run 为 interrupted
    for (const run of codeRunCoordinator.listRuns()) {
      if (run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled" && run.status !== "interrupted") {
        codeRunCoordinator.complete(run.runId, "interrupted", "shutdown");
      }
    }
    // 取消所有 pending approval
    codeRunStore.cleanup();
    for (const handler of this.cleanupHandlers) {
      try { handler(); } catch { /* ignore */ }
    }
    this.cleanupHandlers = [];
    console.log(`[CodeRunWorker] shutdown: ${count} asks rejected`);
  }
}

export const codeRunWorker = new CodeRunWorker();
