import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { findHistorySessionsNeedingBackfill } from "./history-tools";

const enabled = process.env.CYRENE_REAL_HISTORY_BACKFILL_EVAL === "1";
const userDataDir = process.env.CYRENE_REAL_USER_DATA_DIR ?? "";

function digest(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe.skipIf(!enabled)("real-data isolated history backfill", () => {
  it("detects one appended message after a completed marker without touching the real chat store", () => {
    const indexPath = path.join(userDataDir, "cyrene-chats", "index.json");
    const sessions = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Array<{ id?: string }>;
    const sessionId = sessions.map((item) => item.id).find((id): id is string => (
      typeof id === "string" && fs.existsSync(path.join(userDataDir, "cyrene-chats", "sessions", `${id}.json`))
    ));
    expect(sessionId).toBeTruthy();
    if (!sessionId) throw new Error("no real chat session found");
    const realSessionPath = path.join(userDataDir, "cyrene-chats", "sessions", `${sessionId}.json`);
    const realIndexDigest = digest(indexPath);
    const realSessionDigest = digest(realSessionPath);
    const realSession = JSON.parse(fs.readFileSync(realSessionPath, "utf8")) as { messages?: unknown[] };
    expect(realSession.messages?.length ?? 0).toBeGreaterThan(0);

    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-real-history-backfill-"));
    try {
      const isolatedSessionsDir = path.join(isolatedDir, "cyrene-chats", "sessions");
      fs.mkdirSync(isolatedSessionsDir, { recursive: true });
      const isolatedSessionPath = path.join(isolatedSessionsDir, `${sessionId}.json`);
      fs.copyFileSync(realSessionPath, isolatedSessionPath);
      const offset = (realSession.messages?.length ?? 0) - 1;
      const initial = findHistorySessionsNeedingBackfill(isolatedDir, [sessionId], {
        doneSessions: [sessionId],
        sessionOffsets: { [sessionId]: offset },
        sessionFileSignatures: {},
      });
      expect(initial.pendingIds).toEqual([]);

      const isolatedSession = JSON.parse(fs.readFileSync(isolatedSessionPath, "utf8")) as { messages: unknown[] };
      isolatedSession.messages.push({ id: "isolated-turn", role: "user", content: "隔离验证消息", at: Date.now() });
      fs.writeFileSync(isolatedSessionPath, JSON.stringify(isolatedSession));
      const afterAppend = findHistorySessionsNeedingBackfill(isolatedDir, [sessionId], {
        doneSessions: [sessionId],
        sessionOffsets: { [sessionId]: offset },
        sessionFileSignatures: initial.observedSignatures,
      });
      expect(afterAppend.pendingIds).toEqual([sessionId]);
    } finally {
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }

    expect(digest(indexPath)).toBe(realIndexDigest);
    expect(digest(realSessionPath)).toBe(realSessionDigest);
  });
});
