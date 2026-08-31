import { describe, expect, it } from "vitest";
import { shouldListenForDeferredPlanEvents } from "./conversation-run-policy";

describe("React Code conversation run policy", () => {
  it("keeps the post-run plan listener active in both Code and Chat modes", () => {
    expect(shouldListenForDeferredPlanEvents("code")).toBe(true);
    expect(shouldListenForDeferredPlanEvents("chat")).toBe(true);
    expect(shouldListenForDeferredPlanEvents("work")).toBe(false);
    expect(shouldListenForDeferredPlanEvents("learn")).toBe(false);
  });
});
