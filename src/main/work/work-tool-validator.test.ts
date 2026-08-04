import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../orchestrator/tool-registry";
import { validateWorkToolArguments } from "./work-tool-validator";

const tool: ToolDefinition = {
  id: "sample",
  name: "sample",
  description: "sample",
  enabled: true,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      count: { type: "number" },
    },
    required: ["name"],
  },
  execute: async () => "ok",
};

describe("validateWorkToolArguments", () => {
  it("reports missing, unknown and mistyped fields", () => {
    expect(validateWorkToolArguments(tool, { count: "2", extra: true })).toEqual({
      ok: false,
      errors: [
        "missing required fields: name",
        "count expected number",
        "unknown field: extra",
      ],
    });
  });

  it("accepts valid arguments", () => {
    expect(validateWorkToolArguments(tool, { name: "x", count: 2 })).toEqual({ ok: true, errors: [] });
  });
});
