import { describe, expect, it } from "vitest";
import { ChatRunState } from "./run-cancel-state";

describe("ChatRunState", () => {
  it("marks one active run cancelled exactly once", () => {
    const state = new ChatRunState();
    state.begin("run-chat-12345678");

    expect(state.requestCancel()).toBe("run-chat-12345678");
    expect(state.requestCancel()).toBeNull();
    expect(state.isCancellationRequested("run-chat-12345678")).toBe(true);
  });

  it("does not let a stale completion clear a newer run", () => {
    const state = new ChatRunState();
    state.begin("run-old-12345678");
    state.finish("run-old-12345678");
    state.begin("run-new-12345678");

    state.finish("run-old-12345678");
    expect(state.snapshot()).toEqual({ runId: "run-new-12345678", cancelRequested: false });
  });

  it("rejects overlapping renderer runs", () => {
    const state = new ChatRunState();
    state.begin("run-first-12345678");
    expect(() => state.begin("run-second-12345678")).toThrow(/E_CHAT_RUN_ACTIVE/);
  });
});
