import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MinecraftBotManager, resolveMinecraftSidecar } from "./manager";
import { buildMinecraftSoulContext } from "./soul-context";

function writeSidecar(base: string, relative: string): string {
  const file = join(base, relative, "sidecar.cjs");
  mkdirSync(join(base, relative), { recursive: true });
  writeFileSync(file, "\"use strict\";\n", "utf8");
  return file;
}

describe("Minecraft sidecar resolution", () => {
  it("prefers the source tree while developing", () => {
    const root = mkdtempSync(join(tmpdir(), "cyrene-mc-manager-"));
    const appPath = join(root, "app");
    const resourcesPath = join(root, "resources");
    const source = writeSidecar(appPath, join("src", "main", "game-bot", "minecraft-sidecar"));
    writeSidecar(resourcesPath, join("game-bot", "minecraft-sidecar"));
    expect(resolveMinecraftSidecar(appPath, resourcesPath)).toBe(source);
  });

  it("uses packaged resources and reports a missing resource", () => {
    const root = mkdtempSync(join(tmpdir(), "cyrene-mc-manager-"));
    const appPath = join(root, "app");
    const resourcesPath = join(root, "resources");
    const packaged = writeSidecar(resourcesPath, join("game-bot", "minecraft-sidecar"));
    expect(resolveMinecraftSidecar(appPath, resourcesPath)).toBe(packaged);
    expect(resolveMinecraftSidecar(join(root, "none"), join(root, "also-none"))).toBeNull();
  });
});

describe("Minecraft Soul boundary", () => {
  it("keeps the read-only context builder inside GameBot", () => {
    expect(typeof buildMinecraftSoulContext).toBe("function");
  });
});

describe("Minecraft session summary consent", () => {
  it("does not save before generation and explicit save", async () => {
    const root = mkdtempSync(join(tmpdir(), "cyrene-mc-summary-"));
    const file = join(root, "minecraft-sessions.json");
    const manager = new MinecraftBotManager();
    const internal = manager as unknown as {
      pendingSummary: Record<string, unknown> | null;
      sessionFile: string;
      progress: (event: unknown) => void;
    };
    internal.sessionFile = file;
    internal.progress = () => undefined;
    internal.pendingSummary = {
      id: "draft-1", startedAt: 1, endedAt: 2, serverLabel: "localhost:1314",
      players: ["owner"], durationMinutes: 1, highlights: ["查看状态"],
      conversationSummary: "", recentConversation: [], fallbackSummary: "一起查看了当前状态。",
    };

    expect(manager.getPendingSummaryReview()).toEqual({ type: "summary-review", stage: "offer", id: "draft-1" });
    expect(existsSync(file)).toBe(false);
    expect(await manager.handleSummaryAction("draft-1", "save")).toEqual({ ok: false, error: "请先生成并查看记录草稿" });
    expect(existsSync(file)).toBe(false);

    expect(await manager.handleSummaryAction("draft-1", "generate")).toEqual({ ok: true });
    expect(manager.getPendingSummaryReview()).toMatchObject({ type: "summary-review", stage: "draft", id: "draft-1" });
    expect(existsSync(file)).toBe(false);

    expect(await manager.handleSummaryAction("draft-1", "save")).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
    expect(manager.getPendingSummaryReview()).toBeNull();
  });
});
