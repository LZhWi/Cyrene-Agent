import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { loadMinecraftSessionEvents, saveMinecraftSessionEvent, deleteMinecraftSessionEvent } from "./session-store";

describe("Minecraft session store", () => {
  it("persists a bounded, structured session summary", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cyrene-mc-")), "events.json");
    const saved = saveMinecraftSessionEvent(file, {
      startedAt: 100,
      endedAt: 200,
      serverLabel: " localhost:25565 ",
      players: ["Steve", "Steve", "Alex"],
      summary: " 一起搭建了木屋。 ",
    });
    expect(saved.players).toEqual(["Steve", "Alex"]);
    expect(loadMinecraftSessionEvents(file)).toEqual([saved]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
  });

  it("deletes a saved event for chat-bubble cleanup linkage", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cyrene-mc-")), "events.json");
    const saved = saveMinecraftSessionEvent(file, {
      startedAt: 100,
      endedAt: 200,
      serverLabel: "localhost:25565",
      players: ["Steve"],
      summary: "一起搭建了木屋。",
    });
    expect(deleteMinecraftSessionEvent(file, saved.id)).toBe(true);
    expect(loadMinecraftSessionEvents(file)).toEqual([]);
    expect(deleteMinecraftSessionEvent(file, saved.id)).toBe(false);
  });
});
