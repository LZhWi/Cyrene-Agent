import { parseAndValidateSocialExtraction } from "./extractor";
import type { SocialAtomStore } from "./store";
import type { SocialExtractionInput } from "./types";

export interface SocialContextSchedulerDeps {
  store: SocialAtomStore;
  generate: (input: SocialExtractionInput) => Promise<string>;
  enqueue: (label: string, task: () => Promise<void>) => Promise<unknown>;
  recordMetric?: (metric: {
    outcome: "success" | "failure";
    acceptedCount: number;
    rejectedCount: number;
  }) => void;
}

export function createSocialContextScheduler(deps: SocialContextSchedulerDeps): {
  schedule(input: SocialExtractionInput): void;
} {
  return {
    schedule(input) {
      void deps.enqueue("chat-social-context", async () => {
        const raw = await deps.generate(input);
        const result = parseAndValidateSocialExtraction(raw, input);
        deps.store.applyOperations(input.conversationId, result.operations, input.now);
        deps.recordMetric?.({
          outcome: "success",
          acceptedCount: result.operations.length,
          rejectedCount: result.rejectedCount,
        });
      }).catch(() => {
        deps.recordMetric?.({
          outcome: "failure",
          acceptedCount: 0,
          rejectedCount: 0,
        });
      });
    },
  };
}

