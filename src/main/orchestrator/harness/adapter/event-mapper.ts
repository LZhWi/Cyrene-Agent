import { EventType, type BaseEvent } from "@ag-ui/core";
import type { HarnessEvent } from "../types";
import type { TaskDelegationPresentation } from "../../../../shared/task-session";

const LOG_PREFIX = "[HarnessAdapter]";

export function sendHarnessEventAsAgui(
  event: HarnessEvent,
  messageId: string,
  threadId: string,
  runId: string,
  send: (event: BaseEvent) => void,
): void {
  switch (event.type) {
    case "round_start":
    case "round_end": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.round",
        value: {
          action: event.type === "round_start" ? "start" : "end",
          roundId: event.roundId,
        },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "progress_text": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.process_text",
        value: { content: event.content },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "final_answer": {
      send({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", threadId, runId } as BaseEvent);
      send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.content, threadId, runId } as BaseEvent);
      send({ type: EventType.TEXT_MESSAGE_END, messageId, threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_start": {
      send({ type: EventType.REASONING_MESSAGE_START, messageId: event.messageId, role: "assistant", threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_delta": {
      send({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: event.messageId, delta: event.delta, threadId, runId } as BaseEvent);
      break;
    }
    case "reasoning_end": {
      send({ type: EventType.REASONING_MESSAGE_END, messageId: event.messageId, threadId, runId } as BaseEvent);
      break;
    }
    case "tool_start": {
      send({
        type: EventType.TOOL_CALL_START,
        toolCallId: event.toolCallId,
        toolCallName: event.toolName,
        threadId,
        runId,
      } as BaseEvent);
      send({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: event.toolCallId,
        delta: JSON.stringify(event.args),
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "tool_end": {
      send({
        type: EventType.TOOL_CALL_RESULT,
        messageId: `${messageId}-tool-${event.toolCallId}`,
        toolCallId: event.toolCallId,
        content: event.preview,
        changes: event.changes,
        role: "tool",
        status: event.outcome === "success" ? "success" : "failed",
        threadId,
        runId,
      } as BaseEvent);
      send({
        type: EventType.TOOL_CALL_END,
        toolCallId: event.toolCallId,
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "todo_update": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.todo",
        value: { items: event.items },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "context_usage": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.context.usage",
        value: event.snapshot,
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "runtime_feedback":
      break;
    case "ask_user":
      break;
    case "plan_mode_changed": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.plan",
        value: { action: "state_changed", state: event.state },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "plan_written": {
      send({
        type: EventType.CUSTOM,
        name: "cyrene.plan",
        value: { action: "written", planPath: event.planPath },
        threadId,
        runId,
      } as BaseEvent);
      break;
    }
    case "error":
      console.error(`${LOG_PREFIX} harness error: ${event.message}`);
      break;
  }
}

export function sendTaskLifecycleAsAgui(
  value: TaskDelegationPresentation,
  threadId: string,
  runId: string,
  send: (event: BaseEvent) => void,
): void {
  send({ type: EventType.CUSTOM, name: "cyrene.task", value, threadId, runId } as BaseEvent);
}
