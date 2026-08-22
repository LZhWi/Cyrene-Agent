import { describe, expect, it } from "vitest";
import {
  applyKnownBuiltinMcpPolicy,
  PRIVILEGED_EXTERNAL_POLICY,
  sanitizeRendererMcpConfig,
} from "./mcp-config-policy";

describe("MCP config trust boundary", () => {
  it("does not accept renderer-provided policy downgrades", () => {
    const config = sanitizeRendererMcpConfig({
      id: "custom",
      name: "Custom",
      transport: "stdio",
      command: "node",
      args: ["server.js", 42],
      defaultToolPolicy: { risk: "safe", effectKind: "read" },
      toolPolicyOverrides: { erase: { risk: "safe", effectKind: "read" } },
    });

    expect(config.defaultToolPolicy).toEqual(PRIVILEGED_EXTERNAL_POLICY);
    expect(config.toolPolicyOverrides).toBeUndefined();
    expect(config.args).toEqual(["server.js"]);
  });

  it("keeps arbitrary custom persisted servers unclassified", () => {
    const config = { id: "custom", name: "Custom", transport: "stdio" as const, command: "node" };
    expect(applyKnownBuiltinMcpPolicy(config)).toBe(config);
  });

  it("migrates only known built-in server policies", () => {
    expect(applyKnownBuiltinMcpPolicy({
      id: "playwright-mcp",
      name: "Playwright",
      transport: "stdio",
      command: "npx",
    }).defaultToolPolicy).toEqual({ risk: "input-control", effectKind: "external_side_effect" });
    expect(applyKnownBuiltinMcpPolicy({
      id: "minimax-web-search",
      name: "Search",
      transport: "stdio",
      command: "uvx",
    }).defaultToolPolicy).toEqual({ risk: "network", effectKind: "read" });
  });
});
