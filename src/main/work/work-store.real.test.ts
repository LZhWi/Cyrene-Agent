import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assertSafeFileStem, resolvePathInside } from "../runtime/path-guard";

const fixtureUserData = process.env.CYRENE_REAL_WORK_USER_DATA;

vi.mock("electron", () => ({
  app: { getPath: () => fixtureUserData },
  shell: { openPath: vi.fn() },
}));

function digest(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe.skipIf(!fixtureUserData)("Work store isolated real-data A/B", () => {
  it("preserves valid session mappings and does not mutate copied data", async () => {
    const workRoot = path.join(fixtureUserData!, "cyrene-work");
    const sessionsDir = path.join(workRoot, "sessions");
    const indexPath = path.join(workRoot, "index.json");
    const beforeIndex = fs.existsSync(indexPath) ? digest(indexPath) : null;

    const store = await import("./work-store");
    store.initializeWorkStore();
    const sessions = store.listWorkSessions();

    for (const session of sessions) {
      const safeId = assertSafeFileStem(session.id, "work session id");
      const guarded = resolvePathInside(sessionsDir, `${safeId}.json`);
      expect(guarded).toBe(path.join(sessionsDir, `${session.id}.json`));
      expect(store.getWorkSession(session.id)?.id).toBe(session.id);
    }

    expect(store.getWorkSession("../outside")).toBeNull();
    if (beforeIndex) expect(digest(indexPath)).toBe(beforeIndex);
  });
});
