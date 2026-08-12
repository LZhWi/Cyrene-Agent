import type { CodeGitStatus } from "../../../../../shared/code-git-types";
import type { CodeGitReviewSnapshot, ToolExecutionRecord } from "../../../../../shared/chat-types";

const PROJECT_MUTATION_TOOLS = new Set(["write_file", "apply_patch"]);

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function toolTargetPaths(tool: ToolExecutionRecord): string[] {
  if (tool.status !== "success" || !PROJECT_MUTATION_TOOLS.has(tool.name) || !tool.argsText) return [];
  try {
    const args = JSON.parse(tool.argsText) as Record<string, unknown>;
    return [args.path, args.filePath, args.file_path]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map(normalizePath);
  } catch {
    return [];
  }
}

function fingerprint(status: CodeGitStatus | null | undefined): string {
  if (!status || status.state !== "ready") return status?.state ?? "missing";
  return JSON.stringify({
    files: status.files.map((file) => [normalizePath(file.path), file.kind, file.staged, file.unstaged]).sort(),
    lines: status.lines,
  });
}

export function buildCodeGitReviewSnapshot(input: {
  sessionId: string;
  before: CodeGitStatus | null | undefined;
  after: CodeGitStatus | null | undefined;
  tools: ToolExecutionRecord[];
  capturedAt: number;
}): CodeGitReviewSnapshot | undefined {
  const { after } = input;
  if (!after || after.state !== "ready" || after.files.length === 0) return undefined;
  if (fingerprint(input.before) === fingerprint(after)) return undefined;

  const targets = new Set(input.tools.flatMap(toolTargetPaths));
  if (targets.size === 0) return undefined;
  const belongsToRun = (file: CodeGitStatus["files"][number]) => {
    const candidate = normalizePath(file.path);
    return [...targets].some((target) => target === candidate || target.endsWith(`/${candidate}`));
  };
  const beforeByPath = new Map((input.before?.files ?? []).filter(belongsToRun).map((file) => [normalizePath(file.path), file]));
  const afterByPath = new Map(after.files.filter(belongsToRun).map((file) => [normalizePath(file.path), file]));
  const files = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].map((key) => {
    const beforeFile = beforeByPath.get(key);
    const afterFile = afterByPath.get(key);
    const insertionDelta = (afterFile?.insertions ?? 0) - (beforeFile?.insertions ?? 0);
    const deletionDelta = (afterFile?.deletions ?? 0) - (beforeFile?.deletions ?? 0);
    return {
      path: afterFile?.path ?? beforeFile?.path ?? key,
      kind: afterFile?.kind ?? beforeFile?.kind ?? "modified",
      insertions: Math.max(insertionDelta, 0) + Math.max(-deletionDelta, 0),
      deletions: Math.max(-insertionDelta, 0) + Math.max(deletionDelta, 0),
    };
  }).filter((file) => file.insertions > 0 || file.deletions > 0);
  if (files.length === 0) return undefined;

  return {
    sessionId: input.sessionId,
    files,
    insertions: files.reduce((sum, file) => sum + file.insertions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    capturedAt: input.capturedAt,
  };
}
