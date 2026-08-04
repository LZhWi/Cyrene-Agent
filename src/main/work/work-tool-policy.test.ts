import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../orchestrator/tool-registry";
import { filterWorkTools } from "./work-tool-policy";

function tool(id: string): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    inputSchema: { type: "object", properties: {} },
    enabled: true,
    execute: async () => "ok",
  };
}

describe("filterWorkTools", () => {
  it("blocks tools coupled to Chat history, memory, model runtime, or UI", () => {
    const result = filterWorkTools([
      tool("recall_history"),
      tool("user_memory"),
      tool("delegate_task"),
      tool("ask_user_choice"),
      tool("web_search"),
    ]);

    expect(result.map((item) => item.id)).toEqual(["web_search"]);
  });
});
