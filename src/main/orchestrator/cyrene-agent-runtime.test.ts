import { describe, expect, it } from "vitest";
import { resolveAgentRuntime, resolveExecutionMode } from "./cyrene-agent";

describe("resolveAgentRuntime", () => {
  it("uses LangGraph by default and keeps an explicit legacy rollback", () => {
    expect(resolveAgentRuntime(undefined)).toBe("langgraph");
    expect(resolveAgentRuntime("langgraph")).toBe("langgraph");
    expect(resolveAgentRuntime("legacy")).toBe("legacy");
  });
});

describe("resolveExecutionMode", () => {
  it("uses collaboration by default and honors Soul-only explicitly", () => {
    expect(resolveExecutionMode(undefined)).toBe("collaboration");
    expect(resolveExecutionMode("collaboration")).toBe("collaboration");
    expect(resolveExecutionMode("soul-only")).toBe("soul-only");
  });
});
