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

  it("exposes the ZCode file tool set and shared verification without redundant wrappers", async () => {
    const { toolRegistry } = await import("./tools/registry/tool-registry");
    await import("./tools/built-in-tools");
    await import("./tools/fs-tools");
    const { registerLifeTools } = await import("./tools/life-tools");
    const { registerSearchTextTool } = await import("./tools/search-text-tools");
    const { registerAstGrepTools } = await import("./tools/ast-grep-tools");
    registerLifeTools();
    registerSearchTextTool();
    const { registerZCodeFileTools } = await import("./tools/zcode-file-tools");
    registerZCodeFileTools({
      read: toolRegistry.getById("read_file")!,
      readImage: toolRegistry.getById("read_image")!,
      write: toolRegistry.getById("write_file")!,
      edit: toolRegistry.getById("str_replace")!,
      grep: toolRegistry.getById("search_text")!,
    });
    registerAstGrepTools();

    const registered = new Set(toolRegistry.getAllTools().map((tool) => tool.id));
    const visible = new Set(toolRegistry.getEnabledToolsForMode("code").map((tool) => tool.id));

    for (const id of ["Read", "Write", "Edit", "Glob", "Grep", "ast_grep_search", "ast_grep_replace", "run_shell", "run_verification"]) {
      expect(visible.has(id), `${id} should be available to the model`).toBe(true);
    }
    for (const id of ["read_file", "read_image", "list_dir", "write_file", "str_replace", "search_text"]) {
      expect(registered.has(id), `${id} should remain available as a compatibility backend`).toBe(true);
      expect(visible.has(id), `${id} should be hidden from the model`).toBe(false);
    }
    expect(registered.has("apply_patch")).toBe(false);
    expect(visible.has("git_status")).toBe(false);
    expect(visible.has("search_code")).toBe(false);
    expect(registered.has("delegate_coding")).toBe(false);
    expect(registered.has("delegate_task")).toBe(false);
    expect(registered.has("delegate_document")).toBe(false);
    expect(registered.has("delegate_search")).toBe(false);
    expect(registered.has("todo_write")).toBe(false);
  });
});
