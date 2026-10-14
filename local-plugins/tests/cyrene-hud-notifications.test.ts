import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createNotifications, readProactive } = require("../plugins/cyrene-hud/notifications.cjs");
function fixture() {
  let saved: any;
  const storage = { get: () => saved, set: (_key: string, data: any) => { saved = structuredClone(data); } };
  return { storage, store: createNotifications(storage, () => 100), saved: () => saved };
}
const message = (id: string, at = 101) => ({ id, sessionId: "proactive", at, preview: "新消息" });
describe("HUD proactive notifications", () => {
  it("ignores old history, deduplicates deliveries at the same timestamp and restores unread without replay", () => {
    const f = fixture(), batch = { sessionIds: ["proactive"], messages: [message("old", 99), message("a"), message("b")] };
    expect(f.store.ingest(batch)).toBe(2); expect(f.store.ingest(batch)).toBe(0);
    expect(f.store.view().count).toBe(2);
    const restored = createNotifications(f.storage, () => 900);
    expect(restored.view().count).toBe(2); expect(restored.ingest(batch)).toBe(0);
  });
  it("acknowledges only messages captured before opening so a racing delivery remains unread", () => {
    const f = fixture(); f.store.ingest({ sessionIds: ["proactive"], messages: [message("a")] });
    const target = f.store.target(); f.store.ingest({ sessionIds: ["proactive"], messages: [message("b", 102)] });
    f.store.acknowledge(target);
    expect(f.store.view().count).toBe(1); expect(f.store.target().ids).toEqual(["b"]);
    expect(f.store.contains({ sessionId: "other", ids: ["b"] })).toBe(false);
    f.store.ingest({ sessionIds: [], messages: [] }); expect(f.store.view().count).toBe(0);
  });
  it("projects previews only from proactive model messages and pages past a full burst", async () => {
    const history = Array.from({ length: 450 }, (_, i) => ({ id: String(i), at: i, role: "model", content: "hello\nworld", secret: "private" }));
    history[440].role = "user";
    const invoke = vi.fn(async (channel: string, payload: any) => {
      if (channel === "chats:list") return [{ id: "proactive", mode: "chat", purpose: "proactive-chat", updatedAt: 449 }, { id: "ordinary", mode: "chat" }];
      const end = payload.before ?? history.length, start = Math.max(0, end - payload.limit);
      return { session: { purpose: "proactive-chat", messageCount: history.length }, messages: history.slice(start, end), hasMore: start > 0 };
    });
    const batch = await readProactive(invoke, { since: 100, sessions: {} });
    expect(batch.messages).toHaveLength(349);
    expect(batch.messages.every((item: any) => item.preview === "hello world" && !item.secret && !item.content && item.sessionId === "proactive")).toBe(true);
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(["chats:list", "chats:get-page", "chats:get-page"]);
  });
  it("does not read historical pages when metadata predates activation", async () => {
    const invoke = vi.fn(async () => [{ id: "proactive", mode: "chat", purpose: "proactive-chat", updatedAt: 99 }]);
    expect(await readProactive(invoke, { since: 100, sessions: {} })).toEqual({ sessionIds: ["proactive"], messages: [] });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
