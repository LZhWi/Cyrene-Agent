import { beforeEach, describe, expect, it, vi } from "vitest";

const { addMcpServer } = vi.hoisted(() => ({
  addMcpServer: vi.fn().mockResolvedValue({ ok: true, toolIds: [] }),
}));

vi.mock("../index", () => ({ sendToLive2DWindow: vi.fn() }));
vi.mock("./mcp-manager", () => ({ addMcpServer }));

import "./built-in-tools";
import { toolRegistry } from "./tool-registry";
import { RunControl } from "../runtime/run-control";

describe("built-in MCP installation policy", () => {
  beforeEach(() => addMcpServer.mockClear());

  it("keeps legacy MCP installation configs free of forced tool policies", async () => {
    const tool = toolRegistry.getById("install_mcp_server");

    expect(tool?.risk).toBe("shell");
    await tool?.execute({ id: "custom", name: "Custom", command: "node", args: ["server.js"] });

    const config = addMcpServer.mock.calls[0]?.[0];
    expect(config).toEqual(expect.objectContaining({ id: "custom" }));
    expect(config).not.toHaveProperty("defaultToolPolicy");
  });

  it("kills an in-flight run_shell process when the run is cancelled", async () => {
    const tool = toolRegistry.getById("run_shell")!;
    const control = new RunControl("run-shell-cancel");
    const execution = tool.execute({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    }, {
      userQuery: "",
      runId: control.runId,
      signal: control.signal,
      runControl: control,
    });

    setTimeout(() => control.cancel(), 50);

    await expect(execution).rejects.toThrow(/E_RUN_CANCELLED/);
  }, 5_000);
});
