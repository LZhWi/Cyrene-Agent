import type { ChatMessageItem } from "../components/ChatMessageList";
import type { ComposerInteraction } from "../components/run-presentation";
import type { TodoItem, TodoState } from "../../../../../shared/todo-types";

export interface SessionInteractionEntry {
  interaction: ComposerInteraction;
  busy: boolean;
}

export type SessionInteractionState = Record<string, SessionInteractionEntry>;

export function sessionInteraction(
  state: SessionInteractionState,
  sessionId: string | undefined,
): SessionInteractionEntry | undefined {
  return sessionId ? state[sessionId] : undefined;
}

export function setSessionInteraction(
  state: SessionInteractionState,
  sessionId: string,
  interaction: ComposerInteraction,
  busy = false,
): SessionInteractionState {
  return { ...state, [sessionId]: { interaction, busy } };
}

export function clearSessionInteraction(
  state: SessionInteractionState,
  sessionId: string,
): SessionInteractionState {
  if (!state[sessionId]) return state;
  const next = { ...state };
  delete next[sessionId];
  return next;
}

export function setSessionInteractionBusy(
  state: SessionInteractionState,
  sessionId: string,
  busy: boolean,
): SessionInteractionState {
  const current = state[sessionId];
  return current ? { ...state, [sessionId]: { ...current, busy } } : state;
}

export function patchSessionMessage(
  state: Record<string, ChatMessageItem[]>,
  sessionId: string,
  messageId: string,
  patch: Partial<ChatMessageItem>,
): Record<string, ChatMessageItem[]> {
  return {
    ...state,
    [sessionId]: (state[sessionId] ?? []).map((item) => (
      item.id === messageId ? { ...item, ...patch } : item
    )),
  };
}

export function hydrateSessionMessages(
  state: Record<string, ChatMessageItem[]>,
  sessionId: string,
  storedMessages: ChatMessageItem[],
  hasActiveRun: boolean,
): Record<string, ChatMessageItem[]> {
  if (hasActiveRun && state[sessionId]) return state;
  return { ...state, [sessionId]: storedMessages };
}

export function findSessionIdForRun(
  activeRuns: Record<string, { runId?: string }>,
  runId: string | undefined,
): string | undefined {
  if (!runId) return undefined;
  return Object.entries(activeRuns).find(([, run]) => run.runId === runId)?.[0];
}

type TodoPanelMode = "work" | "daily" | "learn";

interface HarnessTodoPresentation {
  id: string;
  content: string;
  status: string;
}

export function mergeHarnessTodosForMode(
  state: Partial<Record<TodoPanelMode, TodoState>>,
  mode: string,
  items: readonly HarnessTodoPresentation[],
  updatedAt = Date.now(),
): Partial<Record<TodoPanelMode, TodoState>> {
  if (mode !== "work" && mode !== "daily" && mode !== "learn") return state;

  const todos = items.flatMap<TodoItem>((item) => {
    if (!item.id || !item.content) return [];
    if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") return [];
    return [{ id: item.id, content: item.content, status: item.status }];
  });

  return {
    ...state,
    [mode]: { todos, updatedAt, mode },
  };
}
