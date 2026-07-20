import { describe, expect, it, vi } from "vitest";
import type { TurnUnderstanding, TurnUnderstandingInput } from "./contracts";
import { RemoteSemanticEngine } from "./remote-semantic-engine";
import type { SemanticTextGenerator } from "./semantic-engine";

const understanding: TurnUnderstanding = {
  dialogueAct: { type: "select" },
  resolvedReferences: [{
    surface: "第一首",
    targetRef: "music-candidate-1",
    relation: "candidate_position",
  }],
  topicTransition: "continue",
  focusedEntityRefs: ["music-candidate-1"],
  contextualizedQuery: "用户选择当前歌曲候选中的第一首《胆小鬼》。",
  rewriteStatus: "contextualized",
  uncertainties: [],
};

const input: TurnUnderstandingInput = {
  conversationId: "conversation-a",
  turnId: "turn-2",
  stateRevision: 3,
  originalQuery: "第一首吧",
  availableContexts: [{
    contextRef: "music-candidate-1",
    conversationId: "conversation-a",
    domain: "music",
    kind: "candidate",
    label: "胆小鬼 - 梁咏琪",
    position: 1,
    presented: true,
    lifecycle: "active",
    source: "tool_result",
  }],
  recentDialogue: [{ role: "assistant", text: "想听哪一首？" }],
  recentEvents: [],
};

describe("RemoteSemanticEngine", () => {
  it("performs one bounded semantic call and parses strict JSON", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () => JSON.stringify(understanding));
    const engine = new RemoteSemanticEngine(generate, { timeoutMs: 6_000 });

    await expect(engine.understandTurn(input)).resolves.toEqual(understanding);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].systemPrompt).toContain("Never choose or call tools");
    expect(generate.mock.calls[0][0].userPrompt).toContain("music-candidate-1");
  });

  it("accepts the compact dialogueAct shape produced by the semantic model", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () => JSON.stringify({
      ...understanding,
      dialogueAct: "select",
    }));

    await expect(new RemoteSemanticEngine(generate).understandTurn(input)).resolves.toEqual(understanding);
  });

  it("rejects model-authored tool arguments", async () => {
    const generate = vi.fn(async () => JSON.stringify({ ...understanding, trackId: "123" }));

    await expect(new RemoteSemanticEngine(generate).understandTurn(input)).rejects.toThrow(/schema/i);
  });

  it("rejects markdown-wrapped output instead of extracting a JSON fragment", async () => {
    const generate = vi.fn(async () => `\`\`\`json\n${JSON.stringify(understanding)}\n\`\`\``);

    await expect(new RemoteSemanticEngine(generate).understandTurn(input)).rejects.toThrow(/json/i);
  });

  it("aborts a semantic call that exceeds its time budget", async () => {
    const generate = vi.fn((_request, signal?: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));

    await expect(new RemoteSemanticEngine(generate, { timeoutMs: 5 }).understandTurn(input))
      .rejects.toThrow(/timeout/i);
  });
});
