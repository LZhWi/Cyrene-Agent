import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "./tool-registry";

vi.mock("./function-calling", () => ({ runFunctionCallingLoop: vi.fn() }));
vi.mock("./tool-registry", () => ({
  toolRegistry: { getEnabledTools: vi.fn(), getById: vi.fn() },
}));

import { filterSubAgentTools } from "./sub-agent";

function tool(id: string, enabled = true): ToolDefinition {
  return {
    id,
    name: id,
    description: id,
    enabled,
    risk: "safe",
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn(),
  };
}

describe("sub-agent tool isolation", () => {
  it("returns a filtered snapshot without disabling global tool objects", () => {
    const delegate = tool("delegate_task");
    const choice = tool("ask_user_choice");
    const weather = tool("weather");
    const disabled = tool("disabled", false);

    expect(filterSubAgentTools([delegate, choice, weather, disabled])).toEqual([weather]);
    expect(delegate.enabled).toBe(true);
    expect(choice.enabled).toBe(true);
    expect(weather.enabled).toBe(true);
  });
});
