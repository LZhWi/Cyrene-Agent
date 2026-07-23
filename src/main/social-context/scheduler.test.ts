import { describe, expect, it, vi } from "vitest";
import { createSocialContextScheduler } from "./scheduler";
import { createSocialAtomStore } from "./store";
import type { SocialExtractionInput } from "./types";

function extractionInput(): SocialExtractionInput {
  return {
    conversationId: "chat-a",
    userTurn: { id: "user-1", role: "user", text: "我喜欢海边。" },
    assistantTurn: { id: "assistant-1", role: "assistant", text: "海风确实很舒服。" },
    retrievedAtoms: [],
    now: 100,
  };
}

describe("social context scheduler", () => {
  it("queues exactly one extraction call and persists validated operations", async () => {
    const store = createSocialAtomStore();
    const generate = vi.fn().mockResolvedValue(JSON.stringify({
      operations: [{
        operation: "add",
        type: "long_term",
        content: "用户喜欢海边",
        evidenceTurnId: "user-1",
        evidenceQuote: "我喜欢海边",
      }],
    }));
    const enqueue = vi.fn((_label: string, task: () => Promise<void>) => task());
    const scheduler = createSocialContextScheduler({ store, generate, enqueue });

    scheduler.schedule(extractionInput());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(store.listActive("chat-a", 100)).toHaveLength(1);
  });

  it("does not repair or retry a failed extraction", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("network"));
    const enqueue = vi.fn((_label: string, task: () => Promise<void>) => task());
    const scheduler = createSocialContextScheduler({
      store: createSocialAtomStore(),
      generate,
      enqueue,
    });

    scheduler.schedule(extractionInput());
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
