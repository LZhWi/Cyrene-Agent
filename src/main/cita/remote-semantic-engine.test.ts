import { describe, expect, it, vi } from "vitest";
import type { TurnUnderstanding, TurnUnderstandingInput } from "./contracts";
import { RemoteSemanticEngine } from "./remote-semantic-engine";
import type { SemanticTextGenerator, SemanticGeneratorResult } from "./semantic-engine";

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

/** 构造 FC 返回结果 */
function fcResult(overrides?: Partial<{
  rewrittenQuery: string;
  resolvedReferences: Array<{ sourceText: string; targetRef: string }>;
  hasAmbiguity: boolean;
  missingInformation: string;
  contextUpdates: string[];
}>): SemanticGeneratorResult {
  return {
    text: "",
    toolCalls: [{
      name: "submit_context_understanding",
      arguments: JSON.stringify({
        rewrittenQuery: overrides?.rewrittenQuery ?? "用户选择当前歌曲候选中的第一首《胆小鬼》。",
        resolvedReferences: overrides?.resolvedReferences ?? [{ sourceText: "第一首", targetRef: "music-candidate-1" }],
        ambiguity: {
          hasAmbiguity: overrides?.hasAmbiguity ?? false,
          ...(overrides?.missingInformation ? { missingInformation: overrides.missingInformation } : {}),
        },
        contextUpdates: overrides?.contextUpdates ?? ["music-candidate-1"],
      }),
    }],
  };
}

describe("RemoteSemanticEngine (Function Calling)", () => {
  it("adapts FC result to TurnUnderstanding with rewritten status", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () => fcResult());
    const engine = new RemoteSemanticEngine(generate, { timeoutMs: 6_000 });

    const result = await engine.understandTurn(input);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].tools).toBeDefined();
    expect(generate.mock.calls[0][0].toolChoice).toBe("required");
    expect(result.contextualizedQuery).toBe("用户选择当前歌曲候选中的第一首《胆小鬼》。");
    expect(result.rewriteStatus).toBe("rewritten");
    expect(result.resolvedReferences).toEqual([{
      surface: "第一首",
      targetRef: "music-candidate-1",
      relation: "direct",
    }]);
    expect(result.focusedEntityRefs).toEqual(["music-candidate-1"]);
  });

  it("sets rewriteStatus to unchanged when rewrittenQuery equals originalQuery", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () =>
      fcResult({ rewrittenQuery: input.originalQuery }),
    );
    const engine = new RemoteSemanticEngine(generate);

    const result = await engine.understandTurn(input);
    expect(result.rewriteStatus).toBe("unchanged");
  });

  it("sets rewriteStatus to insufficient_context when hasAmbiguity is true", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () =>
      fcResult({ hasAmbiguity: true, missingInformation: "无法确定指代" }),
    );
    const engine = new RemoteSemanticEngine(generate);

    const result = await engine.understandTurn(input);
    expect(result.rewriteStatus).toBe("insufficient_context");
  });

  it("throws when submit_context_understanding is not in toolCalls", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () => ({
      text: "some text",
      toolCalls: [{ name: "other_function", arguments: "{}" }],
    }));
    const engine = new RemoteSemanticEngine(generate);

    await expect(engine.understandTurn(input)).rejects.toThrow(/submit_context_understanding/);
  });

  it("throws when toolCall arguments are not valid JSON", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () => ({
      text: "",
      toolCalls: [{ name: "submit_context_understanding", arguments: "not-json" }],
    }));
    const engine = new RemoteSemanticEngine(generate);

    await expect(engine.understandTurn(input)).rejects.toThrow();
  });

  it("validates targetRef exists in availableContexts, drops invalid refs and degrades", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () =>
      fcResult({
        resolvedReferences: [
          { sourceText: "第一首", targetRef: "music-candidate-1" },
          { sourceText: "那个", targetRef: "nonexistent-ref" },
        ],
      }),
    );
    const engine = new RemoteSemanticEngine(generate);

    const result = await engine.understandTurn(input);
    expect(result.resolvedReferences).toHaveLength(1);
    expect(result.resolvedReferences[0].targetRef).toBe("music-candidate-1");
    expect(result.rewriteStatus).toBe("insufficient_context");
  });

  it("validates targetRef belongs to current conversation, drops cross-conversation refs", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () =>
      fcResult({
        resolvedReferences: [
          { sourceText: "第一首", targetRef: "music-candidate-1" },
          { sourceText: "那个", targetRef: "other-conversation-ref" },
        ],
      }),
    );
    const inputWithOther: TurnUnderstandingInput = {
      ...input,
      availableContexts: [
        ...input.availableContexts,
        {
          contextRef: "other-conversation-ref",
          conversationId: "different-conversation",
          domain: "music",
          kind: "candidate",
          label: "其他会话的歌",
          position: 2,
          presented: true,
          lifecycle: "active",
          source: "tool_result",
        },
      ],
    };
    const engine = new RemoteSemanticEngine(generate);

    const result = await engine.understandTurn(inputWithOther);
    expect(result.resolvedReferences).toHaveLength(1);
    expect(result.resolvedReferences[0].targetRef).toBe("music-candidate-1");
    expect(result.rewriteStatus).toBe("insufficient_context");
  });

  it("validates targetRef is not expired, drops expired refs", async () => {
    const generate = vi.fn<SemanticTextGenerator>(async () =>
      fcResult({
        resolvedReferences: [
          { sourceText: "第一首", targetRef: "expired-ref" },
        ],
      }),
    );
    const inputWithExpired: TurnUnderstandingInput = {
      ...input,
      availableContexts: [{
        contextRef: "expired-ref",
        conversationId: "conversation-a",
        domain: "music",
        kind: "candidate",
        label: "过期的歌",
        position: 1,
        presented: true,
        lifecycle: "expired",
        source: "tool_result",
      }],
    };
    const engine = new RemoteSemanticEngine(generate);

    const result = await engine.understandTurn(inputWithExpired);
    expect(result.resolvedReferences).toHaveLength(0);
    expect(result.rewriteStatus).toBe("insufficient_context");
  });

  it("aborts a semantic call that exceeds its time budget", async () => {
    const generate = vi.fn<SemanticTextGenerator>(
      (_request, signal?: AbortSignal) => new Promise<SemanticGeneratorResult>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );

    await expect(new RemoteSemanticEngine(generate, { timeoutMs: 5 }).understandTurn(input))
      .rejects.toThrow(/timeout/i);
  });
});
