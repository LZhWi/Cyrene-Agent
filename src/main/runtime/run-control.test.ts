import { describe, expect, it } from "vitest";
import { RunControl } from "./run-control";

describe("RunControl", () => {
  it("uses one run id and closes the side-effect gate after cancellation", () => {
    const control = new RunControl("run-fixed");
    control.startEffect({ id: "call-1", toolId: "write_file", kind: "mutation" });

    expect(control.cancel()).toBe(true);
    expect(control.cancel()).toBe(false);
    expect(control.signal.aborted).toBe(true);
    expect(control.snapshot()).toMatchObject({
      runId: "run-fixed",
      status: "cancelling",
      effects: [{ id: "call-1", status: "cancelled" }],
    });
    expect(() => control.startEffect({ id: "call-2", toolId: "run_shell", kind: "external_side_effect" }))
      .toThrow(/E_RUN_CANCELLED/);
  });

  it("records completed and failed effects without exposing mutable ledger state", () => {
    const control = new RunControl("run-ledger");
    control.startEffect({ id: "read-1", toolId: "read_file", kind: "read" });
    control.finishEffect("read-1", "completed");
    const snapshot = control.snapshot();
    snapshot.effects[0].status = "failed";

    expect(control.snapshot().effects[0].status).toBe("completed");
  });
});
