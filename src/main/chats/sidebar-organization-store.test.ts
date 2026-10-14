import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionMeta } from "../../shared/chat-types";

const fake = vi.hoisted(() => ({ root: "", sessions: [] as ChatSessionMeta[] }));
vi.mock("./chats-store", () => ({
  getRootDir: () => fake.root,
  listSessions: () => fake.sessions,
}));

function session(id: string, mode: "work" | "code" | "chat", workspaceRoot?: string): ChatSessionMeta {
  return { id, mode, workspaceRoot, title: id, identityId: null, createdAt: 1, updatedAt: 1, messageCount: 0 };
}

describe("sidebar organization store", () => {
  beforeEach(() => {
    vi.resetModules();
    fake.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sidebar-"));
    fake.sessions = [session("work-1", "work", "C:/project"), session("code-1", "code", "C:/project"), session("chat-1", "chat")];
  });
  afterEach(() => {
    if (path.dirname(fake.root) === os.tmpdir() && path.basename(fake.root).startsWith("cyrene-sidebar-")) {
      fs.rmSync(fake.root, { recursive: true, force: true });
    }
  });

  it("migrates only workspace sessions and persists groups and categories", async () => {
    const store = await import("./sidebar-organization-store");
    const initial = store.getSnapshot();
    expect(initial.topLevelOrder).toEqual([
      { type: "session", sessionId: "work-1" },
      { type: "session", sessionId: "code-1" },
    ]);
    expect(initial.projects).toHaveLength(1);
    const projectId = initial.projects[0].id;
    const result = store.applyDraft(initial.revision, {
      ...initial,
      projectCategories: [{ id: "category-1", title: "Active", color: "#ff5b8a" }],
      projectCategoryMembers: { "category-1": [projectId] },
      groups: [{ id: "group-1", title: "Research", color: "#ff5b8a" }],
      topLevelOrder: [{ type: "group", groupId: "group-1" }, { type: "session", sessionId: "code-1" }],
      groupMembers: { "group-1": ["work-1"] },
    });
    expect(result.ok).toBe(true);
    expect(store.applyDraft(initial.revision, initial)).toMatchObject({ ok: false, reason: "conflict" });
    vi.resetModules();
    const reloaded = await import("./sidebar-organization-store");
    expect(reloaded.getSnapshot().groups[0].title).toBe("Research");
    expect(reloaded.getSnapshot().projectCategoryMembers["category-1"]).toEqual([projectId]);
  });

  it("rejects unknown session IDs and reconciles deleted sessions", async () => {
    const store = await import("./sidebar-organization-store");
    const initial = store.getSnapshot();
    expect(store.applyDraft(initial.revision, {
      ...initial,
      topLevelOrder: [...initial.topLevelOrder, { type: "session", sessionId: "missing" }],
    })).toMatchObject({ ok: false, reason: "invalid" });
    fake.sessions = [fake.sessions[0], fake.sessions[2]];
    expect(store.getSnapshot().topLevelOrder).toEqual([{ type: "session", sessionId: "work-1" }]);
  });

  it("adds a newly bound project without requiring an app restart", async () => {
    const store = await import("./sidebar-organization-store");
    expect(store.getSnapshot().projects).toHaveLength(1);
    fake.sessions.push(session("code-new", "code", "C:/new-project"));
    const updated = store.getSnapshot();
    expect(updated.projects.map((project) => project.workspaceRoot)).toContain("C:/new-project");
    expect(updated.topLevelOrder).toContainEqual({ type: "session", sessionId: "code-new" });
  });
});
