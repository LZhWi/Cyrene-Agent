import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeError } from "../agent-runtime-error";

async function loadRunner() {
  const runner = await import("./model-retry-runner").catch(() => undefined);
  expect(runner).toBeDefined();
  return runner!;
}

function transientError(retryAfterMs = 0) {
  return new AgentRuntimeError("E_MODEL_REQUEST_FAILED", "模型暂不可用。", {
    modelFailure: { provider: "test", model: "m", category: "SERVER_ERROR", retryable: true },
    retryAfterMs,
  });
}

describe("runModelRequestWithRetry", () => {
  afterEach(() => vi.useRealTimers());

  it("does not begin a request or wait beyond the remaining whole-run budget", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    const attempt = vi.fn(async () => { throw transientError(10_000); });
    const status = vi.fn();
    const options = { provider: "test", model: "m", maxRetries: 5, idleTimeoutMs: 1000,
      getRemainingBudgetMs: () => 500, onStatus: status };
    await expect(runModelRequestWithRetry(attempt, options)).rejects.toThrow("剩余时间");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    attempt.mockClear();
    await expect(runModelRequestWithRetry(attempt, { ...options, getRemainingBudgetMs: () => 0 })).rejects.toThrow("剩余时间");
    expect(attempt).not.toHaveBeenCalled();
  });

  it("resets idle timeout on protocol activity without extending the whole-run deadline", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    vi.useFakeTimers();
    let activity: (() => void) | undefined;
    const attempt = vi.fn(({ signal, onStreamActivity }) => {
      activity = onStreamActivity;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const pending = runModelRequestWithRetry(attempt, {
      provider: "test", model: "m", maxRetries: 5, idleTimeoutMs: 100,
      getRemainingBudgetMs: () => 250,
    });
    const assertion = expect(pending).rejects.toThrow("剩余时间");
    await vi.advanceTimersByTimeAsync(90);
    activity?.();
    await vi.advanceTimersByTimeAsync(90);
    activity?.();
    await vi.advanceTimersByTimeAsync(70);
    await assertion;
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("最多执行首次请求加用户配置的额外次数", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    let calls = 0;
    await expect(runModelRequestWithRetry(async () => {
      calls += 1;
      throw transientError();
    }, { provider: "test", model: "m", maxRetries: 2, idleTimeoutMs: 1_000 })).rejects.toThrow("模型暂不可用");
    expect(calls).toBe(3);
  });

  it("首次请求收到可见增量后不重发", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    let calls = 0;
    await expect(runModelRequestWithRetry(async ({ onVisibleDelta }) => {
      calls += 1;
      onVisibleDelta();
      throw transientError();
    }, {
      provider: "test", model: "m", maxRetries: 5, idleTimeoutMs: 1_000,
    })).rejects.toThrow("模型暂不可用");
    expect(calls).toBe(1);
  });

  it("重试后收到可见增量时清状态并停止后续重发", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    let calls = 0;
    const statuses: string[] = [];
    await expect(runModelRequestWithRetry(async ({ onVisibleDelta }) => {
      calls += 1;
      if (calls === 1) throw transientError();
      onVisibleDelta();
      throw transientError();
    }, {
      provider: "test", model: "m", maxRetries: 5, idleTimeoutMs: 1_000,
      onStatus: (status) => statuses.push(status.phase),
    })).rejects.toThrow("模型暂不可用");
    expect(calls).toBe(2);
    expect(statuses).toEqual(["waiting", "attempting", "cleared"]);
  });

  it("取消退避等待后不发起下一次请求", async () => {
    const { runModelRequestWithRetry } = await loadRunner();
    const controller = new AbortController();
    let calls = 0;
    const statuses: string[] = [];
    const pending = runModelRequestWithRetry(async () => {
      calls += 1;
      throw transientError(50_000);
    }, {
      provider: "test", model: "m", maxRetries: 2, idleTimeoutMs: 1_000,
      signal: controller.signal,
      onStatus: (status) => {
        statuses.push(status.phase);
        if (status.phase === "waiting") controller.abort();
      },
    });
    await expect(pending).rejects.toThrow();
    expect(calls).toBe(1);
    expect(statuses.at(-1)).toBe("cleared");
  });
});
