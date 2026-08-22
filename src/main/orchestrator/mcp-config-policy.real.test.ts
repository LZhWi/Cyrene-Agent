import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "./mcp-adapter";
import { resolveMcpToolPolicy } from "./mcp-adapter";
import { applyKnownBuiltinMcpPolicy } from "./mcp-config-policy";

const fixturePath = process.env.CYRENE_REAL_MCP_FIXTURE;

describe.skipIf(!fixturePath)("MCP policy isolated real-data A/B", () => {
  it("migrates known built-ins without mutating the copied fixture", async () => {
    const beforeBytes = await readFile(fixturePath!);
    const configs = JSON.parse(beforeBytes.toString("utf8")) as McpServerConfig[];
    const migrated = configs.map(applyKnownBuiltinMcpPolicy);

    expect(migrated).toHaveLength(configs.length);
    expect(migrated.map((config) => config.id)).toEqual(configs.map((config) => config.id));

    for (let index = 0; index < configs.length; index += 1) {
      const before = configs[index];
      const after = migrated[index];
      const beforePolicy = resolveMcpToolPolicy(undefined, undefined, before.defaultToolPolicy);
      const afterPolicy = resolveMcpToolPolicy(undefined, undefined, after.defaultToolPolicy);

      if (before.id === "playwright-mcp") {
        expect(beforePolicy).toBeUndefined();
        expect(afterPolicy).toEqual({ risk: "input-control", effectKind: "external_side_effect" });
      } else if (before.id === "minimax-web-search") {
        expect(beforePolicy).toBeUndefined();
        expect(afterPolicy).toEqual({ risk: "network", effectKind: "read" });
      } else {
        expect(after).toBe(before);
      }
    }

    expect(await readFile(fixturePath!)).toEqual(beforeBytes);
  });
});
