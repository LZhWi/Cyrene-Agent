import { describe, expect, it } from "vitest";
import { resolveAgentRuntime } from "./cyrene-agent";

describe("resolveAgentRuntime", () => {
  it("uses LangGraph by default and keeps an explicit legacy rollback", () => {
    expect(resolveAgentRuntime(undefined)).toBe("langgraph");
    expect(resolveAgentRuntime("langgraph")).toBe("langgraph");
    expect(resolveAgentRuntime("legacy")).toBe("legacy");
  });
});
