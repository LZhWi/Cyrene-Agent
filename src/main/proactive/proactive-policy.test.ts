import { describe, expect, it } from "vitest";
import {
  FOLLOWUP_INTERVAL_MS,
  GLOBAL_PROACTIVE_INTERVAL_MS,
  NORMAL_QUIET_MS,
  SILENT_COOLDOWN_MS,
  canCommitProactiveMessage,
  canStartProactiveGeneration,
  createDefaultProactiveState,
  markNormalConversationEnded,
  markProactiveCommitted,
  markUserActivity,
} from "./proactive-policy";
import type { ProactiveCandidate, ProactiveRuntimeSnapshot } from "./proactive-types";

const NOW = Date.UTC(2026, 6, 13, 6, 0, 0);

function snapshot(patch: Partial<ProactiveRuntimeSnapshot> = {}): ProactiveRuntimeSnapshot {
  return {
    now: NOW,
    localHour: 14,
    idleSec: 0,
    enabled: true,
    conversationBusy: false,
    generationBusy: false,
    screenLocked: false,
    ...patch,
  };
}

function candidate(patch: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  return {
    sceneId: "work_break",
    score: 90,
    sceneCooldownMs: 2 * 60 * 60 * 1000,
    ...patch,
  };
}

describe("proactive hard policy", () => {
  it("enforces normal quiet period and global proactive interval", () => {
    const state = createDefaultProactiveState();
    state.lastNormalConversationEndedAt = NOW - NORMAL_QUIET_MS + 1;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("normal_quiet_period");

    state.lastNormalConversationEndedAt = NOW - NORMAL_QUIET_MS;
    state.lastProactiveAt = NOW - GLOBAL_PROACTIVE_INTERVAL_MS + 1;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("global_cooldown");

    state.lastProactiveAt = NOW - GLOBAL_PROACTIVE_INTERVAL_MS;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).allowed).toBe(true);
  });

  it("blocks inactive nights but allows a recently active night", () => {
    const state = createDefaultProactiveState();
    expect(canStartProactiveGeneration(snapshot({ localHour: 22, idleSec: 600 }), state, candidate()).allowed)
      .toBe(true);
    expect(canStartProactiveGeneration(snapshot({ localHour: 23, idleSec: 60 }), state, candidate()).reason)
      .toBe("night_inactive");
    expect(canStartProactiveGeneration(snapshot({ localHour: 7, idleSec: 59 }), state, candidate()).allowed)
      .toBe(true);
  });

  it("blocks disabled, locked, busy, and overlapping generation states", () => {
    const state = createDefaultProactiveState();
    expect(canStartProactiveGeneration(snapshot({ enabled: false }), state, candidate()).reason).toBe("disabled");
    expect(canStartProactiveGeneration(snapshot({ screenLocked: true }), state, candidate()).reason).toBe("screen_locked");
    expect(canStartProactiveGeneration(snapshot({ conversationBusy: true }), state, candidate()).reason).toBe("conversation_busy");
    expect(canStartProactiveGeneration(snapshot({ generationBusy: true }), state, candidate()).reason).toBe("generation_busy");
  });

  it("requires three hours but allows the same scene for the second message", () => {
    const state = createDefaultProactiveState();
    state.unansweredCount = 1;
    state.lastProactiveAt = NOW - FOLLOWUP_INTERVAL_MS + 1;
    state.lastProactiveScene = "work_break";

    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("followup_cooldown");
    state.lastProactiveAt = NOW - FOLLOWUP_INTERVAL_MS;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).allowed).toBe(true);
    expect(canStartProactiveGeneration(snapshot(), state, candidate({
      sceneId: "rainy_day",
    })).allowed)
      .toBe(true);
  });

  it("allows consecutive back_from_away messages after cooldown but blocks a third unanswered message", () => {
    const state = createDefaultProactiveState();
    const awayCandidate = candidate({ sceneId: "back_from_away", score: 100, sceneCooldownMs: 30 * 60 * 1000 });
    markProactiveCommitted(state, awayCandidate, NOW - FOLLOWUP_INTERVAL_MS);

    expect(canStartProactiveGeneration(snapshot(), state, awayCandidate).allowed).toBe(true);
    expect(canCommitProactiveMessage(snapshot(), state, awayCandidate, state.proactiveEpoch).allowed).toBe(true);

    markProactiveCommitted(state, awayCandidate, NOW);
    expect(canStartProactiveGeneration(snapshot({ now: NOW + FOLLOWUP_INTERVAL_MS }), state, awayCandidate).reason)
      .toBe("unanswered_limit");
  });

  it.each([1, 39, 40, 54, 55])("uses the same score policy for first and second messages at score %s", (score) => {
    const state = createDefaultProactiveState();
    const nextCandidate = candidate({ sceneId: "rainy_day", score });
    const firstDecision = canStartProactiveGeneration(snapshot(), state, nextCandidate);
    expect(firstDecision.allowed).toBe(true);

    state.unansweredCount = 1;
    state.lastProactiveAt = NOW - FOLLOWUP_INTERVAL_MS;
    state.lastProactiveScene = "work_break";
    expect(canStartProactiveGeneration(snapshot(), state, nextCandidate)).toEqual(firstDecision);
    expect(canCommitProactiveMessage(snapshot(), state, nextCandidate, state.proactiveEpoch))
      .toEqual(firstDecision);
  });

  it("hard-blocks a third unanswered proactive message", () => {
    const state = createDefaultProactiveState();
    state.unansweredCount = 2;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("unanswered_limit");
  });

  it("enforces scene cooldown independently from desire", () => {
    const state = createDefaultProactiveState();
    state.globalDesire = 100;
    state.lastFiredAt.work_break = NOW - candidate().sceneCooldownMs + 1;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("scene_cooldown");
  });

  it("rejects a stale generation epoch at commit time", () => {
    const state = createDefaultProactiveState();
    state.proactiveEpoch = 4;
    expect(canCommitProactiveMessage(snapshot(), state, candidate(), 3).reason).toBe("stale_epoch");
    expect(canCommitProactiveMessage(snapshot(), state, candidate(), 4).allowed).toBe(true);
  });

  it("user activity invalidates generation and resets only anti-harassment state", () => {
    const state = createDefaultProactiveState();
    state.proactiveEpoch = 2;
    state.unansweredCount = 1;
    state.affinity.rainy_day = 1.4;

    markUserActivity(state);

    expect(state.proactiveEpoch).toBe(3);
    expect(state.unansweredCount).toBe(0);
    expect(state.affinity.rainy_day).toBe(1.4);
  });

  it("normal conversation end resets desire and starts quiet period", () => {
    const state = createDefaultProactiveState();
    state.globalDesire = 88;
    markNormalConversationEnded(state, NOW);
    expect(state.globalDesire).toBe(0);
    expect(state.lastNormalConversationEndedAt).toBe(NOW);
    expect(state.proactiveEpoch).toBe(1);
  });

  it("committing records scene and increments unanswered count", () => {
    const state = createDefaultProactiveState();
    markProactiveCommitted(state, candidate(), NOW);
    expect(state.unansweredCount).toBe(1);
    expect(state.lastProactiveAt).toBe(NOW);
    expect(state.lastProactiveScene).toBe("work_break");
    expect(state.lastFiredAt.work_break).toBe(NOW);
  });

  it("blocks during silent cooldown and allows after it expires", () => {
    const state = createDefaultProactiveState();
    state.lastSilentAt = NOW - SILENT_COOLDOWN_MS + 1;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).reason).toBe("silent_cooldown");

    state.lastSilentAt = NOW - SILENT_COOLDOWN_MS;
    expect(canStartProactiveGeneration(snapshot(), state, candidate()).allowed).toBe(true);
  });

  it("user activity clears silent cooldown", () => {
    const state = createDefaultProactiveState();
    state.lastSilentAt = NOW - 60_000;
    markUserActivity(state);
    expect(state.lastSilentAt).toBe(null);
  });
});
