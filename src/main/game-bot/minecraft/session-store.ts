import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { MinecraftSessionEvent } from "./types";

const MAX_EVENTS = 100;

export interface MinecraftSessionDraft {
  startedAt: number;
  endedAt: number;
  serverLabel: string;
  players: string[];
  summary: string;
}

function isEvent(value: unknown): value is MinecraftSessionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<MinecraftSessionEvent>;
  return typeof event.id === "string"
    && Number.isFinite(event.startedAt)
    && Number.isFinite(event.endedAt)
    && typeof event.serverLabel === "string"
    && Array.isArray(event.players)
    && typeof event.summary === "string"
    && Boolean(event.summary.trim());
}

export function loadMinecraftSessionEvents(file: string): MinecraftSessionEvent[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isEvent).slice(-MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

export function saveMinecraftSessionEvent(file: string, draft: MinecraftSessionDraft): MinecraftSessionEvent {
  const event: MinecraftSessionEvent = {
    id: randomUUID(),
    startedAt: draft.startedAt,
    endedAt: draft.endedAt,
    serverLabel: draft.serverLabel.trim().slice(0, 200),
    players: [...new Set(draft.players.map((name) => name.trim()).filter(Boolean))].slice(0, 50),
    summary: draft.summary.trim().slice(0, 1600),
  };
  const events = [...loadMinecraftSessionEvents(file), event].slice(-MAX_EVENTS);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(events, null, 2), "utf8");
  fs.renameSync(temp, file);
  return event;
}

/** 删除聊天气泡时联动清理：与 call-context-store 的 deleteCallContextEvent 同构。 */
export function deleteMinecraftSessionEvent(file: string, eventId: string): boolean {
  const events = loadMinecraftSessionEvents(file);
  const next = events.filter((event) => event.id !== eventId);
  if (next.length === events.length) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(temp, file);
  return true;
}
