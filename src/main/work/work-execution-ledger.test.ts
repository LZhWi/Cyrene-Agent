import { describe, expect, it, vi } from "vitest";
import { WorkExecutionLedger } from "./work-execution-ledger";

describe("WorkExecutionLedger", () => {
  it("reuses only identical successful executions", async () => {
    const ledger = new WorkExecutionLedger();
    const run = vi.fn(async () => ({ status: "succeeded" as const, toolId: "write", output: "ok" }));
    const first = await ledger.execute("write", { b: 2, a: 1 }, run);
    const second = await ledger.execute("write", { a: 1, b: 2 }, run);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not cache failed executions", async () => {
    const ledger = new WorkExecutionLedger();
    const run = vi.fn(async () => ({ status: "failed" as const, toolId: "write", output: "no" }));
    await ledger.execute("write", {}, run);
    await ledger.execute("write", {}, run);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
