import type { TaskSession } from "./task-session";

export interface WorkspaceEntry { name: string; path: string; directory: boolean; }
export type WorkspaceFileView = { kind: "text"; content: string } | { kind: "image"; dataUrl: string };
export type InspectorResult<T> = { ok: true; value: T } | { ok: false; error: string };
export interface WorkspaceInspectorApi {
  listFiles(sessionId: string, directory: string, offset?: number): Promise<InspectorResult<{ entries: WorkspaceEntry[]; hasMore: boolean }>>;
  readFile(sessionId: string, file: string): Promise<InspectorResult<WorkspaceFileView>>;
  getTask(sessionId: string, taskId: string): Promise<InspectorResult<TaskSession>>;
}
