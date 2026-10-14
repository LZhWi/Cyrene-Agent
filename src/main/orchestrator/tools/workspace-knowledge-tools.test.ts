import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../../rag/index", () => ({
  formatImportedDocumentChunk: vi.fn(), searchImportedDocumentChunks: vi.fn(), searchMemory: vi.fn(),
}));
import { toolRegistry } from "./registry/tool-registry";
import { registerWorkspaceKnowledgeTools } from "./workspace-knowledge-tools";
import type { ToolContext } from "./registry/tool-context";

const ids = ["workspace_document_outline", "workspace_document_read", "workspace_knowledge_list", "workspace_knowledge_read", "workspace_knowledge_save"];
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-tools-test-"));
  fs.writeFileSync(path.join(root, "guide.md"), "# Guide\n## Evidence\nThe result is pending.\n");
  registerWorkspaceKnowledgeTools();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function call(id: string, args: Record<string, unknown>, ctx?: ToolContext) {
  return toolRegistry.getById(id)!.execute(args, ctx);
}

describe("workspace knowledge tool boundary", () => {
  it("exposes only Work/Code/Learn defaults and rejects direct Chat calls even with visibility overrides", async () => {
    for (const mode of ["work", "code", "learn"] as const) {
      const visible = toolRegistry.getEnabledToolsForMode(mode).map(t => t.id);
      expect(ids.every(id => visible.includes(id))).toBe(true);
    }
    const chatTools = toolRegistry.getEnabledToolsForMode("chat").map(t => t.id);
    expect(ids.some(id => chatTools.includes(id))).toBe(false);
    const overrides = Object.fromEntries(ids.map(id => [id, { chat: true }]));
    expect(toolRegistry.getEnabledToolsForMode("chat", overrides).some(t => ids.includes(t.id))).toBe(true);
    for (const id of ids) {
      await expect(call(id, { path: "guide.md" }, { userQuery: "", mode: "chat", resolvedWorkspaceRoot: root }))
        .rejects.toMatchObject({ code: "MODE_NOT_ALLOWED" });
    }
    expect(fs.readdirSync(root)).toEqual(["guide.md"]);
  });

  it("requires the trusted context root and never accepts an argument root or process.cwd fallback", async () => {
    await expect(call(ids[0], { path: "guide.md", workspaceRoot: root })).rejects.toMatchObject({ code: "MODE_NOT_ALLOWED" });
    await expect(call(ids[0], { path: "guide.md", workspaceRoot: root }, { mode: "learn", userQuery: "" }))
      .rejects.toMatchObject({ code: "WORKSPACE_REQUIRED" });
  });

  it.each(["work", "code", "learn"] as const)("supports the complete outline/read/save/list/read/update flow in %s", async mode => {
    const ctx = { mode, resolvedWorkspaceRoot: root, userQuery: "Summarize guide" } satisfies ToolContext;
    const outline = JSON.parse(await call(ids[0], { path: "guide.md" }, ctx));
    const read = JSON.parse(await call(ids[1], { path: "guide.md", contentHash: outline.contentHash, nodeId: "h2" }, ctx));
    expect(read.content).toContain("The result is pending.");
    const args = { kind: "topic", slug: "result", title: "Result", body: "The result is pending.[S1]",
      sources: [{ ...read.evidence, quote: "The result is pending." }] };
    const saved = JSON.parse(await call(ids[4], args, ctx));
    expect(saved).toMatchObject({ success: true, evidenceStatus: "quotes_validated" });
    expect(saved.changes[0]).toMatchObject({ kind: "added", file: path.join(root, "cyrene-knowledge/topic/result.md") });
    const listed = JSON.parse(await call(ids[2], { query: "pending" }, ctx));
    expect(listed.pages[0].slug).toBe("result");
    const page = JSON.parse(await call(ids[3], { kind: "topic", slug: "result" }, ctx));
    expect(page.stale).toBe(false);
    const updated = JSON.parse(await call(ids[4], { ...args, body: "Still pending.[S1]", expectedContentHash: page.contentHash }, ctx));
    expect(updated.changes[0].kind).toBe("modified");
    fs.appendFileSync(path.join(root, "guide.md"), "Changed source\n");
    expect(JSON.parse(await call(ids[3], { kind: "topic", slug: "result" }, ctx)).stale).toBe(true);
  });

  it("declares read/write permission and verification policies and bypasses stale read caches", () => {
    for (const id of ids.slice(0, 4)) {
      expect(toolRegistry.getById(id)).toMatchObject({ risk: "fs-read", effectKind: "read", verificationPolicy: "none", ledgerPolicy: "bypass", needsContext: true });
    }
    expect(toolRegistry.getById(ids[4])).toMatchObject({ risk: "fs-write", effectKind: "mutation", verificationPolicy: "artifact", needsContext: true });
  });

  it("rejects invalid paging, missing source fields and absolute destinations", async () => {
    const ctx: ToolContext = { mode: "code", userQuery: "", resolvedWorkspaceRoot: root };
    await expect(call(ids[0], { path: "guide.md", offset: -1 }, ctx)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(call(ids[0], { path: "guide.md", limit: Number.NaN }, ctx)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(call(ids[4], { kind: "topic", slug: "result", title: "X", body: "[S1]", sources: [{}] }, ctx))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(call(ids[4], { kind: "progress", slug: "../escape", title: "X", body: "Pending", sources: [] }, ctx))
      .rejects.toMatchObject({ code: "INVALID_PAGE" });
  });
});
