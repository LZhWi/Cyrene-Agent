import { describe, expect, it } from "vitest";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ComposerInteraction } from "../components/run-presentation";
import {
  clearSessionInteraction,
  findSessionIdForRun,
  hydrateSessionMessages,
  mergeHarnessTodosForMode,
  patchSessionMessage,
  sessionInteraction,
  setSessionInteraction,
} from "./session-runtime-state";

const ask = (id: string): ComposerInteraction => ({
  kind: "ask",
  id,
  responseKind: "single",
  question: "请选择",
  options: [
    { id: "yes", label: "是" },
    { id: "no", label: "否" },
  ],
});

describe("session runtime presentation state", () => {
  it("shows an interaction only in its owning session", () => {
    const state = setSessionInteraction({}, "session-a", ask("ask-a"));

    expect(sessionInteraction(state, "session-a")?.interaction.id).toBe("ask-a");
    expect(sessionInteraction(state, "session-b")).toBeUndefined();
  });

  it("clears one session interaction without dismissing another", () => {
    const state = setSessionInteraction(
      setSessionInteraction({}, "session-a", ask("ask-a")),
      "session-b",
      ask("ask-b"),
    );

    const next = clearSessionInteraction(state, "session-a");

    expect(sessionInteraction(next, "session-a")).toBeUndefined();
    expect(sessionInteraction(next, "session-b")?.interaction.id).toBe("ask-b");
  });

  it("keeps updating the background session message", () => {
    const state: Record<string, ChatMessageItem[]> = {
      "session-a": [{ id: "assistant-a", role: "assistant", content: "" }],
      "session-b": [{ id: "assistant-b", role: "assistant", content: "other" }],
    };

    const next = patchSessionMessage(state, "session-a", "assistant-a", { content: "continued" });

    expect(next["session-a"][0].content).toBe("continued");
    expect(next["session-b"]).toBe(state["session-b"]);
  });

  it("does not replace a live run placeholder when the session is reopened", () => {
    const live = [{ id: "assistant-a", role: "assistant" as const, content: "streaming", streaming: true }];
    const stored = [{ id: "user-a", role: "user" as const, content: "request" }];

    const next = hydrateSessionMessages({ "session-a": live }, "session-a", stored, true);

    expect(next["session-a"]).toBe(live);
  });

  it("finds the session that owns a permission run", () => {
    const sessionId = findSessionIdForRun({
      "session-a": { runId: "run-a" },
      "session-b": { runId: "run-b" },
    }, "run-b");

    expect(sessionId).toBe("session-b");
  });

  it("routes Harness todo updates into the existing mode TodoPanel state", () => {
    const previous = {
      daily: {
        todos: [{ id: "daily-1", content: "散步", status: "pending" as const }],
        updatedAt: 10,
        mode: "daily" as const,
      },
    };

    const next = mergeHarnessTodosForMode(previous, "work", [
      { id: "1", content: "读取核心循环", status: "completed" },
      { id: "2", content: "审查停止逻辑", status: "in_progress" },
      { id: "3", content: "已取消的旧步骤", status: "cancelled" },
    ], 20);

    expect(next.daily).toBe(previous.daily);
    expect(next.work).toEqual({
      todos: [
        { id: "1", content: "读取核心循环", status: "completed" },
        { id: "2", content: "审查停止逻辑", status: "in_progress" },
      ],
      updatedAt: 20,
      mode: "work",
    });
  });
});
