import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

const electronMock = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => electronMock.userDataDir },
  shell: { openPath: vi.fn() },
}));

function treeHash(root: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        hash.update(relative);
        hash.update(fs.readFileSync(absolute));
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

const realRoot = process.env.CYRENE_REAL_CHAT_ROOT ?? "";

describe("chats store real-data isolation", () => {
  it.skipIf(!realRoot || !fs.existsSync(realRoot))("rebuilds copied real sessions without changing the source corpus", async () => {
    const sourceHashBefore = treeHash(realRoot);
    const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-real-chat-isolated-"));
    try {
      const isolatedRoot = path.join(isolatedUserData, "cyrene-chats");
      fs.cpSync(realRoot, isolatedRoot, { recursive: true });
      electronMock.userDataDir = isolatedUserData;

      const primary = path.join(isolatedRoot, "index.json");
      const lastGood = path.join(isolatedRoot, "index.last-good.json");
      fs.writeFileSync(primary, "{isolated-corruption", "utf8");
      fs.writeFileSync(lastGood, "{isolated-corruption", "utf8");

      vi.resetModules();
      const store = await import("./chats-store");
      store.initialize();
      expect(store.getStorageStatus().status).toBe("recovery_pending");

      const result = store.approveIndexRebuild();
      expect(result.ok).toBe(true);
      expect(result.invalidSessions).toEqual([]);
      expect(result.recoveredSessions).toBeGreaterThan(0);
      expect(store.listSessions()).toHaveLength(result.recoveredSessions);
      expect(treeHash(realRoot)).toBe(sourceHashBefore);
    } finally {
      fs.rmSync(isolatedUserData, { recursive: true, force: true });
    }
  });

  it.skipIf(!realRoot || !fs.existsSync(realRoot))("requires approval before repairing a copied real session", async () => {
    const sourceHashBefore = treeHash(realRoot);
    const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-real-session-isolated-"));
    try {
      const isolatedRoot = path.join(isolatedUserData, "cyrene-chats");
      fs.cpSync(realRoot, isolatedRoot, { recursive: true });
      electronMock.userDataDir = isolatedUserData;
      const sessionsDir = path.join(isolatedRoot, "sessions");
      const sessionName = fs.readdirSync(sessionsDir).find(
        (name) => name.endsWith(".json") && !name.endsWith(".last-good.json"),
      );
      expect(sessionName).toBeTruthy();
      const sessionId = sessionName!.slice(0, -".json".length);
      const primary = path.join(sessionsDir, sessionName!);

      vi.resetModules();
      let store = await import("./chats-store");
      store.initialize();
      const original = store.getSession(sessionId);
      expect(original).not.toBeNull();
      const lastGood = path.join(sessionsDir, `${sessionId}.last-good.json`);
      expect(fs.existsSync(lastGood)).toBe(true);
      fs.writeFileSync(primary, "{isolated-session-corruption", "utf8");

      vi.resetModules();
      store = await import("./chats-store");
      store.initialize();
      expect(store.getStorageStatus()).toEqual(expect.objectContaining({
        status: "session_recovery_pending",
        sessionId,
        recoverable: true,
      }));
      expect(fs.readFileSync(primary, "utf8")).toBe("{isolated-session-corruption");

      const result = store.approveSessionRecovery();
      expect(result).toEqual(expect.objectContaining({ ok: true, action: "recovered" }));
      expect(store.getSession(sessionId)?.messages).toEqual(original?.messages);
      expect(treeHash(realRoot)).toBe(sourceHashBefore);
    } finally {
      fs.rmSync(isolatedUserData, { recursive: true, force: true });
    }
  });
});
