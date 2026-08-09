import { describe, expect, it } from "vitest";
import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ComposerInteraction } from "../components/run-presentation";
import {
  clearSessionInteraction,
  findSessionIdForRun,
  hasActiveRunForSession,
  hydrateSessionMessages,
  mergeHarnessTodosForSession,
  patchSessionMessage,
  sessionInteraction,
  setSessionInteraction,
  startSessionTodos,
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

  it("reads the active-run record from the real session map", () => {
    const activeRuns = {
      "session-a": { runId: "run-a" },
    };

    expect(hasActiveRunForSession(activeRuns, "session-a")).toBe(true);
    expect(hasActiveRunForSession(activeRuns, "session-b")).toBe(false);
  });

  it("finds the session that owns a permission run", () => {
    const sessionId = findSessionIdForRun({
      "session-a": { runId: "run-a" },
      "session-b": { runId: "run-b" },
    }, "run-b");

    expect(sessionId).toBe("session-b");
  });

  it("keeps Todo state independent for two sessions in the same mode", () => {
    const previous = {
      "session-b": {
        runId: "run-b",
        todos: [{ id: "b-1", content: "检查 B", status: "pending" as const }],
        updatedAt: 10,
      },
    };

    const next = mergeHarnessTodosForSession(previous, "session-a", "run-a", [
      { id: "1", content: "读取核心循环", status: "completed" },
      { id: "2", content: "审查停止逻辑", status: "in_progress" },
      { id: "3", content: "已取消的旧步骤", status: "cancelled" },
    ], 20);

    expect(next["session-b"]).toBe(previous["session-b"]);
    expect(next["session-a"]).toEqual({
      runId: "run-a",
      todos: [
        { id: "1", content: "读取核心循环", status: "completed" },
        { id: "2", content: "审查停止逻辑", status: "in_progress" },
      ],
      updatedAt: 20,
    });
  });

  it("ignores a stale Todo event from another run in the same session", () => {
    const previous = startSessionTodos({}, "session-a", "run-new", 10);

    const next = mergeHarnessTodosForSession(previous, "session-a", "run-old", [
      { id: "old", content: "旧任务", status: "pending" },
    ], 20);

    expect(next).toBe(previous);
  });

  it("filters cancelled, malformed, and unsupported Todo items", () => {
    const next = mergeHarnessTodosForSession({}, "session-a", "run-a", [
      { id: "ok", content: "保留", status: "pending" },
      { id: "cancelled", content: "取消", status: "cancelled" },
      { id: "", content: "无 ID", status: "pending" },
      { id: "unknown", content: "未知", status: "blocked" },
    ], 20);

    expect(next["session-a"].todos).toEqual([
      { id: "ok", content: "保留", status: "pending" },
    ]);
  });

  it("starts a new run by clearing only the owning session Todo", () => {
    const previous = {
      "session-a": { runId: "run-old", todos: [{ id: "old", content: "旧", status: "pending" as const }], updatedAt: 1 },
      "session-b": { runId: "run-b", todos: [{ id: "b", content: "B", status: "pending" as const }], updatedAt: 2 },
    };

    const next = startSessionTodos(previous, "session-a", "run-new", 30);

    expect(next["session-a"]).toEqual({ runId: "run-new", todos: [], updatedAt: 30 });
    expect(next["session-b"]).toBe(previous["session-b"]);
  });
});
