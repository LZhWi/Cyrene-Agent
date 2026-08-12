import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => process.cwd() },
}));

vi.mock("../index", () => ({
  sendToLive2DWindow: vi.fn(),
}));

vi.mock("./mcp-manager", () => ({
  addMcpServer: vi.fn(),
}));

vi.mock("./vision-captioner", () => ({
  captionImage: vi.fn(),
}));

describe("Work tool boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers general coding tools and shared verification without the removed delegate", async () => {
    const { toolRegistry } = await import("./tool-registry");
    await import("./built-in-tools");
    await import("./fs-tools");
    const { registerLifeTools } = await import("./life-tools");
    const { registerSearchCodeTool } = await import("./search-code-tools");
    registerLifeTools();
    registerSearchCodeTool();

    const registered = new Set(toolRegistry.getAllTools().map((tool) => tool.id));

    for (const id of [
      "apply_patch",
      "search_code",
      "write_file",
      "run_shell",
      "read_file",
      "list_dir",
      "run_verification",
    ]) {
      expect(registered.has(id), `${id} should remain registered`).toBe(true);
    }
    expect(registered.has("delegate_coding")).toBe(false);
    expect(registered.has("delegate_task")).toBe(false);
    expect(registered.has("delegate_document")).toBe(false);
    expect(registered.has("delegate_search")).toBe(false);
    expect(registered.has("todo_write")).toBe(false);
  });
});
