import type { CodeGitStatus } from "../../../../../shared/code-git-types";
import type { CodeGitReviewSnapshot, ToolExecutionRecord } from "../../../../../shared/chat-types";
import { buildCodeGitReviewSnapshot } from "./code-git-review";

export interface LiveCodeGitReview {
  readonly sessionId: string;
  readonly assistantId: string;
  update(after: CodeGitStatus | undefined): CodeGitReviewSnapshot | undefined;
  freeze(after: CodeGitStatus | undefined): CodeGitReviewSnapshot | undefined;
}

export function createLiveCodeGitReview(input: {
  sessionId: string;
  assistantId: string;
  before: CodeGitStatus | undefined;
  tools: () => ToolExecutionRecord[];
}): LiveCodeGitReview {
  let terminal = false;
  let snapshot: CodeGitReviewSnapshot | undefined;
  const produce = (after: CodeGitStatus | undefined) => buildCodeGitReviewSnapshot({
    sessionId: input.sessionId,
    before: input.before,
    after,
    tools: input.tools(),
    capturedAt: Date.now(),
  });
  return {
    sessionId: input.sessionId,
    assistantId: input.assistantId,
    update(after) {
      if (terminal) return snapshot;
      snapshot = produce(after) ?? snapshot;
      return snapshot;
    },
    freeze(after) {
      if (!terminal) {
        snapshot = produce(after) ?? snapshot;
        terminal = true;
      }
      return snapshot;
    },
  };
}
