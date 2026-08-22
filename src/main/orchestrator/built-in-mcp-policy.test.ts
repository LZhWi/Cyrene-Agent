import { beforeEach, describe, expect, it, vi } from "vitest";

const { addMcpServer } = vi.hoisted(() => ({
  addMcpServer: vi.fn().mockResolvedValue({ ok: true, toolIds: [] }),
}));

vi.mock("../index", () => ({ sendToLive2DWindow: vi.fn() }));
vi.mock("./mcp-manager", () => ({ addMcpServer }));

import "./built-in-tools";
import { toolRegistry } from "./tool-registry";

describe("built-in MCP installation policy", () => {
  beforeEach(() => addMcpServer.mockClear());

  it("requires shell permission and classifies installed third-party tools as external side effects", async () => {
    const tool = toolRegistry.getById("install_mcp_server");

    expect(tool?.risk).toBe("shell");
    await tool?.execute({ id: "custom", name: "Custom", command: "node", args: ["server.js"] });

    expect(addMcpServer).toHaveBeenCalledWith(expect.objectContaining({
      id: "custom",
      defaultToolPolicy: { risk: "shell", effectKind: "external_side_effect" },
    }));
  });
});
