import { app } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { CallContextEvent } from "./call-context";

const FILE_NAME = "phone-context-events.json";
const MAX_EVENTS = 100;

function storePath(): string {
  return path.join(app.getPath("userData"), FILE_NAME);
}

function isEvent(value: unknown): value is CallContextEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CallContextEvent>;
  return typeof event.id === "string"
    && Number.isFinite(event.startedAt)
    && Number.isFinite(event.endedAt)
    && typeof event.summary === "string"
    && Boolean(event.summary.trim());
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
  const event: CallContextEvent = {
    id: randomUUID(),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    summary: input.summary.trim().slice(0, 1200),
  };
  const events = [...loadCallContextEvents(), event].slice(-MAX_EVENTS);
  const target = storePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(events, null, 2), "utf8");
  fs.renameSync(temp, target);
  return event;
}

export function deleteCallContextEvent(eventId: string): boolean {
  const events = loadCallContextEvents();
  const next = events.filter((event) => event.id !== eventId);
  if (next.length === events.length) return false;
  const target = storePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(temp, target);
  return true;
}
