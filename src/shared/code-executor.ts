/** Code-only bridge. Native Cyrene execution continues to use the existing AG-UI API. */
export const CODE_EXECUTOR_CHANNEL = "code-executor:invoke";
export type CodeExecutorAction = "state" | "connect" | "submit" | "answer" | "cancel" | "sync" | "explain";
export interface CodeExecutorConfig {
  model: string; effort: string; skillPath: string; sandbox: "read-only" | "workspace-write"; autoExplain: boolean;
}
export interface CodeExecutorTask {
  id: string; message: string; status: string; threadId?: string; turnId?: string;
  finalText: string; progress: string; diff: string; error?: string;
  explanation?: string; explanationError?: string; explaining?: boolean;
  config: CodeExecutorConfig & { cwd: string };
}
export interface CodeExecutorSnapshot {
  config: CodeExecutorConfig & { cwd: string };
  connection: string; connectionError: string;
  models: { model: string; displayName?: string; isDefault?: boolean; defaultReasoningEffort: string; supportedReasoningEfforts: { reasoningEffort: string }[] }[];
  skills: { name: string; path: string; description?: string; enabled: boolean }[];
  tasks: CodeExecutorTask[];
  prompts: { id: string | number; taskId: string; method: string; params: {
    command?: string; availableDecisions?: string[];
    questions?: { id: string; question: string; isSecret?: boolean; options?: { label: string; description?: string }[] }[];
    [key: string]: unknown;
  } }[];
}
export type CodeExecutorResult = { ok: true; data: CodeExecutorSnapshot } | { ok: false; error: string };
export interface CodeExecutorApi {
  invoke(sessionId: string, action: CodeExecutorAction, data?: unknown): Promise<CodeExecutorResult>;
}
export const isCodeTaskBusy = (status: string) => ["submitting", "inProgress", "waiting", "cancelling"].includes(status);
