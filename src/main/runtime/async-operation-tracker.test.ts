import { describe, expect, it } from "vitest";
import { AsyncOperationTracker } from "./async-operation-tracker";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("AsyncOperationTracker", () => {
  it("waits for active operations and removes them after settlement", async () => {
    const tracker = new AsyncOperationTracker();
    const gate = deferred<void>();
    tracker.track(gate.promise);
    let settled = false;
    const waiting = tracker.settleAll().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(tracker.size).toBe(1);
    gate.resolve();
    await waiting;
    expect(tracker.size).toBe(0);
  });

  it("contains rejected operations while preserving their caller-visible rejection", async () => {
    const tracker = new AsyncOperationTracker();
    const gate = deferred<void>();
    const tracked = tracker.track(gate.promise);
    gate.reject(new Error("write failed"));
    await expect(tracked).rejects.toThrow("write failed");
    await expect(tracker.settleAll()).resolves.toBeUndefined();
    expect(tracker.size).toBe(0);
  });
});
