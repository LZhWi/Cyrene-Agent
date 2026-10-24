import { describe, expect, it } from "vitest";
import { createKeyedQueue } from "./keyed-queue";

describe("channels/keyed-queue", () => {
  it("同一个键串行执行，不同键可以并行执行", async () => {
    const queue = createKeyedQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("conversation:1", async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
    });
    const second = queue.run("conversation:1", async () => {
      events.push("second:start");
    });
    const parallel = queue.run("conversation:2", async () => {
      events.push("parallel:start");
    });

    await parallel;
    expect(events).toEqual(["first:start", "parallel:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:start",
      "parallel:start",
      "first:end",
      "second:start",
    ]);
  });

  it("达到单键待处理上限时拒绝新任务", async () => {
    const queue = createKeyedQueue({ maxPendingPerKey: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = queue.run("external:1", () => gate);
    await expect(queue.run("external:1", async () => undefined))
      .rejects.toThrow("queue_full:external:1");

    release();
    await running;
    await expect(queue.run("external:1", async () => "恢复"))
      .resolves.toBe("恢复");
  });

  it("前一个任务失败后仍继续执行后续任务", async () => {
    const queue = createKeyedQueue();

    const failed = queue.run("conversation:1", async () => {
      throw new Error("模拟失败");
    });
    const recovered = queue.run("conversation:1", async () => "继续执行");

    await expect(failed).rejects.toThrow("模拟失败");
    await expect(recovered).resolves.toBe("继续执行");
  });
});
