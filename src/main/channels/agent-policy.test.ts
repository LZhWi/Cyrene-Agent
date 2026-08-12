import { describe, expect, it } from "vitest";
import { resolveChannelAgentPolicy } from "./agent-policy";

describe("mobile channel agent policy", () => {
  it("routes off through ChatLoop without tools", () => {
    expect(resolveChannelAgentPolicy("off")).toEqual({
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
    });
  });

  it("routes all through CyreneHarness without Ask or approval", () => {
    expect(resolveChannelAgentPolicy("all")).toEqual({
      executionMode: "work",
      exposeTools: true,
      includeInteractiveTools: false,
      permissionMode: "allow_all",
    });
  });
});
