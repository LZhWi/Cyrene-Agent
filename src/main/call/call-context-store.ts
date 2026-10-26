import { app } from "electron";
import { randomUUID } from "node:crypto";
import { getServiceState } from "../storage/service-state";

export interface CallContextEvent {
  id: string;
  startedAt: number;
  endedAt: number;
  summary: string;
}

const MAX_EVENTS = 100;

function isEvent(value: unknown): value is CallContextEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CallContextEvent>;
  return typeof event.id === "string" && Number.isFinite(event.startedAt)
    && Number.isFinite(event.endedAt) && typeof event.summary === "string" && Boolean(event.summary.trim());
}

export function loadCallContextEvents(): CallContextEvent[] {
    const parsed: unknown = getServiceState(app.getPath("userData"), "native-call-context").get("state");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEvent).sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_EVENTS);
}

export function saveCallContextEvent(input: Omit<CallContextEvent, "id">): CallContextEvent {
  const event = { id: randomUUID(), startedAt: input.startedAt, endedAt: input.endedAt,
    summary: input.summary.trim().slice(0, 1200) };
  const events = [...loadCallContextEvents(), event].slice(-MAX_EVENTS);
  getServiceState(app.getPath("userData"), "native-call-context").set("state", events);
  return event;
}

export function formatCallContextEvent(event: CallContextEvent): string {
  const minutes = Math.max(1, Math.round((event.endedAt - event.startedAt) / 60_000));
  return ["[语音通话梗概]", `用户在本条时间戳对应的时间开始了一次语音通话，持续约 ${minutes} 分钟。`,
    event.summary.trim(), "这只是通话内容梗概，不是用户在当前聊天中刚刚发送的消息。"].join("\n");
}
