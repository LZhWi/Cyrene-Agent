import { app } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CallContextEvent {
  id: string;
  startedAt: number;
  endedAt: number;
  summary: string;
}

const FILE_NAME = "phone-context-events.json";
const MAX_EVENTS = 100;

function storePath(): string {
  return path.join(app.getPath("userData"), FILE_NAME);
}

function isEvent(value: unknown): value is CallContextEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CallContextEvent>;
  return typeof event.id === "string" && Number.isFinite(event.startedAt)
    && Number.isFinite(event.endedAt) && typeof event.summary === "string" && Boolean(event.summary.trim());
}

export function loadCallContextEvents(): CallContextEvent[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEvent).sort((a, b) => a.startedAt - b.startedAt).slice(-MAX_EVENTS);
  } catch {
    return [];
  }
}

export function saveCallContextEvent(input: Omit<CallContextEvent, "id">): CallContextEvent {
  const event = { id: randomUUID(), startedAt: input.startedAt, endedAt: input.endedAt,
    summary: input.summary.trim().slice(0, 1200) };
  const target = storePath();
  const events = [...loadCallContextEvents(), event].slice(-MAX_EVENTS);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(events, null, 2), "utf8");
  fs.renameSync(temporary, target);
  return event;
}

export function formatCallContextEvent(event: CallContextEvent): string {
  const minutes = Math.max(1, Math.round((event.endedAt - event.startedAt) / 60_000));
  return ["[语音通话梗概]", `用户在本条时间戳对应的时间开始了一次语音通话，持续约 ${minutes} 分钟。`,
    event.summary.trim(), "这只是通话内容梗概，不是用户在当前聊天中刚刚发送的消息。"].join("\n");
}
