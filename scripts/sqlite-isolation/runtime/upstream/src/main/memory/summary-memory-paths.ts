import { createHash } from "node:crypto";
import path from "node:path";
import type { ChatSessionRecord } from "../../shared/chat-types";

export interface SummaryMemoryPaths {
  sessionPath: string;
  workspacePath?: string;
}

function sessionKey(conversationId: string): string {
  if (typeof conversationId !== "string" || conversationId.length === 0) {
    throw new Error("SUMMARY_MEMORY_INVALID_SESSION_ID");
  }
  return createHash("sha256").update(conversationId, "utf8").digest("hex");
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveSummaryMemoryPaths(input: {
  conversationId: string;
  userDataRoot: string;
  session?: ChatSessionRecord | null;
}): SummaryMemoryPaths {
  const key = sessionKey(input.conversationId);
  const workspaceRoot = input.session?.mode === "chat" ? undefined : input.session?.workspaceBinding?.workspaceRoot;
  if (typeof workspaceRoot === "string" && workspaceRoot.length > 0) {
    if (!path.isAbsolute(workspaceRoot)) throw new Error("SUMMARY_MEMORY_INVALID_WORKSPACE_ROOT");
    const root = path.resolve(workspaceRoot);
    const memoryRoot = path.resolve(root, ".cyrene", "memory");
    const sessionsRoot = path.resolve(memoryRoot, "sessions");
    const sessionPath = path.join(sessionsRoot, `${key}.md`);
    const workspacePath = path.join(memoryRoot, "workspace.md");
    if (!inside(root, sessionPath) || !inside(root, workspacePath)) {
      throw new Error("SUMMARY_MEMORY_PATH_OUTSIDE_WORKSPACE");
    }
    return { sessionPath, workspacePath };
  }

  const root = path.resolve(input.userDataRoot);
  const sessionRoot = path.resolve(root, "summary-memory", "sessions");
  const sessionPath = path.join(sessionRoot, `${key}.md`);
  if (!inside(root, sessionPath)) throw new Error("SUMMARY_MEMORY_PATH_OUTSIDE_USER_DATA");
  return { sessionPath };
}
