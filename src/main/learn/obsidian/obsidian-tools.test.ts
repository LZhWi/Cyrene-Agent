import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolContext } from "../../orchestrator/tools/registry/tool-context";
import { createObsidianWorkspace } from "./obsidian-workspace-service";
import { applyProgressUpdate } from "../progress/learn-progress-service";

vi.mock("../../rag/index", () => ({ formatImportedDocumentChunk: vi.fn(), searchImportedDocumentChunks: vi.fn(), searchMemory: vi.fn() }));
vi.mock("./obsidian-open", () => ({ openNote: vi.fn() }));
import { toolRegistry } from "../../orchestrator/tools/registry/tool-registry";
import { registerObsidianTools } from "./obsidian-tools";
import { openNote } from "./obsidian-open";

let temp: string;
let a: ToolContext;
let b: ToolContext;
const ids = ["obsidian_list_files", "obsidian_search", "obsidian_read_file", "obsidian_read_section", "obsidian_edit", "obsidian_open_note"];
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "learn-vault-tools-"));
  for (const name of ["A", "B"]) {
    const root = path.join(temp, name);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "note.md"), `# Topic\n## Section\n${name}-only\n`);
  }
  a = { mode: "learn", userQuery: "", resolvedWorkspaceRoot: path.join(temp, "A"), runId: "A" };
  b = { mode: "learn", userQuery: "", resolvedWorkspaceRoot: path.join(temp, "B"), runId: "B" };
  registerObsidianTools();
  vi.mocked(openNote).mockClear();
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));
function call(id: string, args: Record<string, unknown>, ctx?: ToolContext) { return toolRegistry.getById(id)!.execute(args, ctx); }

describe("Obsidian run-bound tools", () => {
  it("isolates list/search/read/section/edit/open for two concurrent Learn runs", async () => {
    const [readA, readB] = await Promise.all([call("obsidian_read_file", { path: "note.md" }, a), call("obsidian_read_file", { path: "note.md" }, b)]);
    expect(readA).toContain("A-only"); expect(readA).not.toContain("B-only");
    expect(readB).toContain("B-only");
    expect(await call("obsidian_search", { query: "A-only" }, b)).toContain("未找到匹配");
    expect(await call("obsidian_read_section", { path: "note.md", headingPath: ["Topic", "Section"] }, a)).toContain("A-only");
    await Promise.all([a, b].map(ctx => call("obsidian_edit", { operation: "create", path: "created.md", content: ctx.runId }, ctx)));
    expect(fs.readFileSync(path.join(temp, "A/created.md"), "utf8")).toBe("A");
    expect(fs.readFileSync(path.join(temp, "B/created.md"), "utf8")).toBe("B");
    expect(await call("obsidian_list_files", {}, a)).toContain("created.md");
    await call("obsidian_open_note", { path: "note.md" }, b);
    expect(openNote).toHaveBeenCalledWith(expect.objectContaining({ vaultName: "B", filePath: "note.md" }));
  });

  it("returns usable full hashes and refreshes them after background progress updates", async () => {
    const workspace = createObsidianWorkspace(a.resolvedWorkspaceRoot!);
    await applyProgressUpdate(workspace, { hasMeaningfulChange: true, topic: "Topic", masteryDelta: 1 });
    const before = await call("obsidian_read_file", { path: "learn/progress.md" }, a);
    const hash = before.match(/contentHash: ([a-f0-9]{64})/)![1];
    await applyProgressUpdate(workspace, { hasMeaningfulChange: true, topic: "Topic", masteryDelta: 1 });
    await expect(call("obsidian_edit", { operation: "replace_file", path: "learn/progress.md", content: "Stale", expectedContentHash: hash }, a))
      .rejects.toMatchObject({ code: "CONTENT_CONFLICT" });
    const after = await call("obsidian_read_file", { path: "learn/progress.md" }, a);
    expect(after.match(/contentHash: ([a-f0-9]{64})/)![1]).not.toBe(hash);
    expect(toolRegistry.getById("obsidian_read_file")?.ledgerPolicy).toBe("bypass");
  });

  it("rejects other modes or absent trusted roots even if tools are manually exposed", async () => {
    for (const id of ids) {
      expect(toolRegistry.getById(id)?.needsContext).toBe(true);
      for (const mode of ["chat", "work", "code"] as const) {
        await expect(call(id, {}, { ...a, mode })).rejects.toMatchObject({ code: "LEARN_MODE_REQUIRED" });
      }
      await expect(call(id, { workspaceRoot: a.resolvedWorkspaceRoot }, { mode: "learn", userQuery: "" })).rejects.toMatchObject({ code: "LEARN_WORKSPACE_REQUIRED" });
    }
    expect(ids.every(id => !toolRegistry.getEnabledToolsForMode("chat").some(t => t.id === id))).toBe(true);
  });

  it("keeps registered definitions independent of the last run and honors cancellation", async () => {
    const read = toolRegistry.getById("obsidian_read_file")!;
    await read.execute({ path: "note.md" }, b);
    expect(await read.execute({ path: "note.md" }, a)).toContain("A-only");
    expect(toolRegistry.getById("obsidian_read_file")).toBe(read);
    const controller = new AbortController(); controller.abort();
    await expect(read.execute({ path: "note.md" }, { ...a, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
