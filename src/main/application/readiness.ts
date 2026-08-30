/**
 * 启动就绪门（StartupReadiness）：
 * 生命周期阶段推进与降级能力（degraded capabilities）互相独立 ——
 * 某个能力降级只记录原因，不改变 phase。
 */

export type StartupPhase =
  | "preparing"
  | "shell-ready"
  | "core-ready"
  | "background-starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface DegradedReason {
  capability: string;
  message: string;
  at: number;
  error?: unknown;
}

export interface StartupReadiness {
  getPhase(): StartupPhase;
  transition(next: StartupPhase): void;
  waitFor(target: "core-ready" | "ready", signal?: AbortSignal): Promise<void>;
  markDegraded(reason: DegradedReason): void;
  clearDegraded(capability: string): void;
  getDegradedReasons(): ReadonlyMap<string, DegradedReason>;
}

export interface CreateStartupReadinessOptions {
  /** 时钟注入（测试用）；默认 Date.now。 */
  now?: () => number;
}

/**
 * 允许的阶段迁移（与 composition-root 计划一致）：
 *   preparing → shell-ready → core-ready → background-starting → ready
 *   preparing/shell-ready/core-ready/background-starting/ready/failed → stopping → stopped
 *   preparing/shell-ready/core-ready/background-starting → failed
 */
const ALLOWED_TRANSITIONS: Readonly<Record<StartupPhase, readonly StartupPhase[]>> = {
  preparing: ["shell-ready", "stopping", "failed"],
  "shell-ready": ["core-ready", "stopping", "failed"],
  "core-ready": ["background-starting", "stopping", "failed"],
  "background-starting": ["ready", "stopping", "failed"],
  ready: ["stopping"],
  stopping: ["stopped"],
  stopped: [],
  failed: ["stopping"],
};

// 线性启动阶段（用于 waitFor 的“已到达”判断）；shutdown/failed 不参与排序。
const STARTUP_ORDER: Readonly<Record<string, number>> = {
  preparing: 0,
  "shell-ready": 1,
  "core-ready": 2,
  "background-starting": 3,
  ready: 4,
};

// 进入这些阶段时，所有未决 waiter 都要被拒绝。
const REJECTION_MESSAGES: Readonly<Partial<Record<StartupPhase, string>>> = {
  failed: "startup failed",
  stopping: "startup aborted: stopping",
  stopped: "startup aborted: stopped",
};

interface Waiter {
  target: "core-ready" | "ready";
  resolve: () => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}

export function createStartupReadiness(options: CreateStartupReadinessOptions = {}): StartupReadiness {
  const now = options.now ?? Date.now;
  let phase: StartupPhase = "preparing";
  const degraded = new Map<string, DegradedReason>();
  const waiters = new Set<Waiter>();

  function settleWaiters(): void {
    if (waiters.size === 0) return;

    const rejectionMessage = REJECTION_MESSAGES[phase];
    if (rejectionMessage !== undefined) {
      const pending = [...waiters];
      waiters.clear();
      for (const waiter of pending) {
        waiter.cleanup();
        waiter.reject(new Error(rejectionMessage));
      }
      return;
    }

    const reached = STARTUP_ORDER[phase];
    if (reached === undefined) return;
    for (const waiter of [...waiters]) {
      if (reached >= STARTUP_ORDER[waiter.target]) {
        waiters.delete(waiter);
        waiter.cleanup();
        waiter.resolve();
      }
    }
  }

  return {
    getPhase: () => phase,

    transition(next) {
      const allowed = ALLOWED_TRANSITIONS[phase];
      if (!allowed.includes(next)) {
        throw new Error(`invalid startup phase transition: ${phase} -> ${next}`);
      }
      phase = next;
      settleWaiters();
    },

    waitFor(target, signal) {
      const rejectionMessage = REJECTION_MESSAGES[phase];
      if (rejectionMessage !== undefined) {
        return Promise.reject(new Error(rejectionMessage));
      }
      const reached = STARTUP_ORDER[phase];
      if (reached !== undefined && reached >= STARTUP_ORDER[target]) {
        return Promise.resolve();
      }
      if (signal?.aborted) {
        return Promise.reject(new Error("startup wait aborted"));
      }

      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          target,
          resolve,
          reject,
          cleanup: () => {
            if (signal) signal.removeEventListener("abort", onAbort);
          },
        };
        const onAbort = () => {
          waiters.delete(waiter);
          reject(new Error("startup wait aborted"));
        };
        waiters.add(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },

    markDegraded(reason) {
      degraded.set(reason.capability, { ...reason, at: reason.at ?? now() });
    },

    clearDegraded(capability) {
      degraded.delete(capability);
    },

    getDegradedReasons: () => degraded,
  };
}
