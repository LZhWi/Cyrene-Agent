import { describe, expect, it } from "vitest";
import { policyFor, type AgentFileAccessLevel, type ToolRiskLevel } from "./permission";

const risks: ToolRiskLevel[] = ["safe", "fs-read", "fs-write", "shell", "network", "input-control"];

describe("agent tool permission policy", () => {
  it.each<AgentFileAccessLevel>(["read-only", "scoped", "per-action", "full"])(
    "always allows safe tools at %s",
    (level) => expect(policyFor(level, "safe")).toBe("allow"),
  );

  it("keeps read-only retrieval and network tools usable", () => {
    expect(policyFor("read-only", "fs-read")).toBe("allow");
    expect(policyFor("read-only", "network")).toBe("allow");
    expect(policyFor("read-only", "fs-write")).toBe("deny");
    expect(policyFor("read-only", "shell")).toBe("deny");
    expect(policyFor("read-only", "input-control")).toBe("deny");
  });

  it("restores the legacy scoped compatibility policy", () => {
    expect(policyFor("scoped", "fs-read")).toBe("allow");
    expect(policyFor("scoped", "fs-write")).toBe("allow");
    expect(policyFor("scoped", "network")).toBe("allow");
    expect(policyFor("scoped", "shell")).toBe("deny");
    expect(policyFor("scoped", "input-control")).toBe("deny");
  });

  it("asks for every non-safe operation in per-action and allows all in full", () => {
    for (const risk of risks.filter((value) => value !== "safe")) {
      expect(policyFor("per-action", risk)).toBe("ask");
      expect(policyFor("full", risk)).toBe("allow");
    }
  });
});
