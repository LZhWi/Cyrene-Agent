import { describe, expect, it } from "vitest";
import type { ModelVisibleContext, TurnUnderstanding, TurnUnderstandingInput } from "./contracts";
import { validateUnderstanding } from "./understanding-validator";

const now = 1_000;

function context(overrides: Partial<ModelVisibleContext> = {}): ModelVisibleContext {
  return {
    contextRef: "music-candidate-1",
    conversationId: "conversation-a",
    domain: "music",
    kind: "candidate",
    label: "胆小鬼 - 梁咏琪",
    position: 1,
    presented: true,
    lifecycle: "active",
    expiresAt: now + 500,
    source: "tool_result",
    ...overrides,
  };
}

function input(availableContexts = [context()]): TurnUnderstandingInput {
  return {
    conversationId: "conversation-a",
    turnId: "turn-2",
    stateRevision: 2,
    originalQuery: "第一首吧",
    availableContexts,
    recentDialogue: [],
    recentEvents: [],
  };
}

function candidate(overrides: Partial<TurnUnderstanding> = {}): TurnUnderstanding {
  return {
    dialogueAct: { type: "select" },
    resolvedReferences: [{
      surface: "第一首",
      targetRef: "music-candidate-1",
      relation: "candidate_position",
    }],
    topicTransition: "continue",
    focusedEntityRefs: ["music-candidate-1"],
    contextualizedQuery: "用户选择当前候选中的第一首《胆小鬼》。",
    rewriteStatus: "contextualized",
    uncertainties: [],
    ...overrides,
  };
}

describe("validateUnderstanding", () => {
  it("accepts a known active reference from the same conversation", () => {
    expect(validateUnderstanding(input(), candidate(), now)).toEqual({
      status: "accepted",
      understanding: candidate(),
    });
  });

  it("removes a cross-conversation reference and falls back to the original query", () => {
    const result = validateUnderstanding(
      input([context({ conversationId: "conversation-b" })]),
      candidate(),
      now,
    );

    expect(result.status).toBe("degraded");
    if (result.status !== "degraded") throw new Error("expected degraded result");
    expect(result.understanding.resolvedReferences).toEqual([]);
    expect(result.understanding.focusedEntityRefs).toEqual([]);
    expect(result.understanding.contextualizedQuery).toBe("第一首吧");
    expect(result.understanding.rewriteStatus).toBe("ambiguous");
    expect(result.reasons).toContain("cross_conversation_ref:music-candidate-1");
  });

  it("rejects expired references", () => {
    const result = validateUnderstanding(
      input([context({ expiresAt: now, lifecycle: "active" })]),
      candidate(),
      now,
    );

    expect(result.status).toBe("degraded");
    if (result.status === "degraded") {
      expect(result.reasons).toContain("expired_ref:music-candidate-1");
      expect(result.understanding.contextualizedQuery).toBe("第一首吧");
    }
  });

  it("rejects candidate references that were never presented to the user", () => {
    const result = validateUnderstanding(
      input([context({ presented: false })]),
      candidate(),
      now,
    );

    expect(result.status).toBe("degraded");
    if (result.status === "degraded") {
      expect(result.reasons).toContain("unpresented_ref:music-candidate-1");
      expect(result.understanding.contextualizedQuery).toBe("第一首吧");
    }
  });

  it("removes invented references and unsupported rewritten facts", () => {
    const invented = candidate({
      resolvedReferences: [{ surface: "那首", targetRef: "invented-ref", relation: "focused" }],
      focusedEntityRefs: ["invented-ref"],
      contextualizedQuery: "播放模型凭空想出的歌曲。",
    });
    const result = validateUnderstanding(input(), invented, now);

    expect(result.status).toBe("degraded");
    if (result.status === "degraded") {
      expect(result.understanding.resolvedReferences).toEqual([]);
      expect(result.understanding.contextualizedQuery).toBe("第一首吧");
      expect(result.reasons).toContain("unknown_ref:invented-ref");
    }
  });

  it("keeps independently valid dialogue and topic fields during rewrite fallback", () => {
    const result = validateUnderstanding(input([]), candidate({
      dialogueAct: { type: "correct" },
      topicTransition: "return",
      resolvedReferences: [],
      focusedEntityRefs: [],
    }), now);

    expect(result.status).toBe("degraded");
    if (result.status === "degraded") {
      expect(result.understanding.dialogueAct.type).toBe("correct");
      expect(result.understanding.topicTransition).toBe("return");
      expect(result.understanding.contextualizedQuery).toBe("第一首吧");
    }
  });
});
