import { parseDiff, type FileData } from "react-diff-view";
import type { CodeGitDiffResult } from "../../../../../shared/code-git-types";

export type CodeDiffViewModel =
  | { kind: "ready"; files: FileData[] }
  | Exclude<CodeGitDiffResult, { kind: "ready" }>;

export function buildCodeDiffViewModel(result: CodeGitDiffResult): CodeDiffViewModel {
  if (result.kind !== "ready") return result;
  return { kind: "ready", files: parseDiff(result.patch) };
}
