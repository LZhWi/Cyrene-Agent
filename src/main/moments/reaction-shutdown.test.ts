import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReactionQueue } from "./reaction-queue";

const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reaction-shutdown-")), "queue.json");
const input = (postId: string) => ({ kind: "post_eval" as const, actor: "cyrene", postId, dueAt: 0 });

describe("reaction shutdown and restart", () => {
  it("finishes the current effect but leaves the remaining batch for restart", async () => {
    const target = file(), gate = deferred<void>();
    const apply = vi.fn(() => gate.promise);
    const executor = { decide: vi.fn(async () => ({ type: "decided" as const, decision: { action: "like" as const } })), apply };
    const queue = createReactionQueue({ filePath: target, executor });
    queue.enqueue(input("one")); queue.enqueue(input("two"));
    const run = queue.drainOnce();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    let done = false;
    const stop = queue.stop(new AbortController().signal).then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    gate.resolve(); await Promise.all([run, stop]);
    expect(queue.list().map(t => t.postId)).toEqual(["two"]);
    const restarted = createReactionQueue({ filePath: target, executor: { ...executor, apply: async () => {} } });
    await restarted.drainOnce();
    expect(restarted.list()).toEqual([]);
  });

  it("retains the original task on deadline and refuses late model effects", async () => {
    const target = file(), gate = deferred<any>(), apply = vi.fn(async () => {});
    const queue = createReactionQueue({ filePath: target, executor: { decide: () => gate.promise, apply } });
    queue.enqueue(input("one")); const before = fs.readFileSync(target, "utf8");
    const run = queue.drainOnce(), controller = new AbortController();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = queue.stop(controller.signal); controller.abort(); await stop;
    gate.resolve({ type: "decided", decision: { action: "like" } }); await run;
    expect(apply).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(warning).toHaveBeenCalledWith("[Shutdown] moments reaction drain deadline reached");
    warning.mockRestore();
    expect(await queue.drainOnce()).toBe(false);
    const restarted = createReactionQueue({ filePath: target, executor: { decide: async () => ({ type: "decided", decision: { action: "silent" } }), apply } });
    await restarted.drainOnce(); expect(restarted.list()).toEqual([]);
  });

  it("failed application preserves the cached decision across restart", async () => {
    const target = file();
    const decide = vi.fn(async () => ({ type: "decided" as const, decision: { action: "like" as const } }));
    const queue = createReactionQueue({ filePath: target, executor: { decide, apply: async () => { throw Error("synthetic write failure"); } } });
    queue.enqueue(input("one"));
    await queue.drainOnce(); await queue.stop();
    const restarted = createReactionQueue({ filePath: target, executor: { decide, apply: async () => {} } });
    await restarted.drainOnce();
    expect(decide).toHaveBeenCalledOnce(); expect(restarted.list()).toEqual([]);
  });
});
