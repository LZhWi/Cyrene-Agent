import { describe, expect, it, vi } from "vitest";
import { CitaService } from "./cita-service";
import { ContextStore } from "./context-store";
import type { CitaSemanticEngine } from "./semantic-engine";
import type { CitaSettings, ModelVisibleContext, TurnUnderstanding } from "./contracts";

const validUnderstanding: TurnUnderstanding = {
  dialogueAct: { type: "inform" },
  resolvedReferences: [],
  topicTransition: "continue",
  focusedEntityRefs: [],
  contextualizedQuery: "你好",
  rewriteStatus: "unchanged",
  uncertainties: [],
};

const unsafeProjectionPatches: Array<Partial<ModelVisibleContext>> = [
  { attributes: { apiKey: "secret-value" } },
  { attributes: { cookie: "MUSIC_U=secret" } },
  { label: "Authorization: Bearer secret-value" },
];

function turnInput(overrides: Partial<Parameters<CitaService["prepareTurn"]>[0]> = {}) {
  return {
    conversationId: "conversation-a",
    turnId: "turn-1",
    originalQuery: "你好",
    recentDialogue: [],
    ...overrides,
  };
}

function createService(input: {
  understandTurn?: CitaSemanticEngine["understandTurn"];
  settings?: CitaSettings;
}) {
  const engine: CitaSemanticEngine = {
    understandTurn: input.understandTurn ?? vi.fn(async () => validUnderstanding),
  };
  return new CitaService({
    store: new ContextStore({ now: () => 1_000 }),
    engine,
    getSettings: () => input.settings ?? { enabled: true, semanticEngine: "remote" },
    now: () => 1_000,
  });
}

describe("CitaService", () => {
  it("bypasses state and semantic calls when disabled", async () => {
    const understandTurn = vi.fn();
    const service = createService({
      understandTurn,
      settings: { enabled: false, semanticEngine: "remote" },
    });

    service.ingest({
      type: "conversation_reset",
      eventId: "event-1",
      conversationId: "conversation-a",
      occurredAt: 1_000,
      source: "test",
    });
    const result = await service.prepareTurn(turnInput());

    expect(understandTurn).not.toHaveBeenCalled();
    expect(result.contextBlock).toBe("");
  });

  it("calls understandTurn exactly once when enabled", async () => {
    const understandTurn = vi.fn(async () => validUnderstanding);
    const service = createService({ understandTurn });

    await service.prepareTurn(turnInput());

    expect(understandTurn).toHaveBeenCalledTimes(1);
  });

  it("emits a readable prepare and result trace", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const service = createService({ understandTurn: vi.fn(async () => validUnderstanding) });
      await service.prepareTurn(turnInput());
      const lines = log.mock.calls.map((call) => call.join(" ")).join("\n");

      expect(lines).toContain("[CITA/Trace] prepare conversation=conversation-a");
      expect(lines).toContain("status=accepted dialogueAct=inform rewrite=unchanged refs=[]");
    } finally {
      log.mockRestore();
    }
  });

  it("degrades without blocking when remote understanding fails", async () => {
    const service = createService({
      understandTurn: vi.fn(async () => { throw new Error("timeout"); }),
    });

    const result = await service.prepareTurn(turnInput({ originalQuery: "第一首吧" }));

    expect(result.contextPackage?.originalQuery).toBe("第一首吧");
    expect(result.contextPackage?.contextualizedQuery).toBe("第一首吧");
    expect(result.contextPackage?.semanticStatus).toBe("unavailable");
  });

  it("works without observeTurn", async () => {
    const service = createService({ understandTurn: vi.fn(async () => validUnderstanding) });

    await expect(service.prepareTurn(turnInput())).resolves.toMatchObject({
      contextBlock: expect.stringContaining("[CITA_CONTEXT]"),
    });
  });

  it("does not invoke the remote engine when the deferred local option is selected", async () => {
    const understandTurn = vi.fn(async () => validUnderstanding);
    const service = createService({
      understandTurn,
      settings: { enabled: true, semanticEngine: "local" },
    });

    const result = await service.prepareTurn(turnInput());

    expect(understandTurn).not.toHaveBeenCalled();
    expect(result.contextPackage?.semanticStatus).toBe("unavailable");
  });

  it.each(unsafeProjectionPatches)("rejects credential-shaped context projections", async (unsafePatch) => {
    const understandTurn = vi.fn<CitaSemanticEngine["understandTurn"]>(async () => validUnderstanding);
    const service = createService({ understandTurn });
    service.ingest({
      type: "context_upserted",
      eventId: "unsafe-1",
      conversationId: "conversation-a",
      occurredAt: 1_000,
      source: "test",
      context: {
        contextRef: "ctx_unsafe",
        conversationId: "conversation-a",
        domain: "test",
        kind: "candidate",
        label: "safe",
        lifecycle: "active",
        source: "tool_result",
        ...unsafePatch,
      },
    });

    const result = await service.prepareTurn(turnInput());
    const semanticInput = understandTurn.mock.calls[0]?.[0];
    expect(semanticInput?.availableContexts).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ contextRef: "ctx_unsafe" }),
    ]));
    expect(result.contextBlock).not.toContain("ctx_unsafe");
    expect(result.contextBlock).not.toContain("secret-value");
    expect(result.contextBlock).not.toContain("MUSIC_U");
  });
});
