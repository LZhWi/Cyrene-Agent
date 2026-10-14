import { expect, it } from "vitest";
import { createSourceInvalidationQueue, findInvalidHostSources } from "../plugins/companion-memory/src/source-reconciliation";

it("replays invalidation after a derived-store failure and restart", () => {
  const data = new Map();
  const storage = { get: (key: string) => structuredClone(data.get(key)), set: (key: string, value: unknown) => data.set(key, structuredClone(value)), rootDir: () => "unused" };
  const change = { conversationId: "c", allMessages: false, invalidatedMessageIds: ["u"] };
  const queue = createSourceInvalidationQueue(storage); queue.enqueue(change);
  expect(() => queue.drain(() => { throw new Error("disk full"); })).toThrow();
  const restarted = createSourceInvalidationQueue(storage), applied: unknown[] = [];
  restarted.drain(item => applied.push(item));
  expect(applied).toEqual([change]); expect(restarted.pending()).toEqual([]);
});

it("detects edits and deletions made while disabled, but fails closed on read errors", async () => {
  const turns = [{ id: "t", sessionId: "c", user: "original", assistant: "reply", userAt: 1, assistantAt: 2,
    inputMessageId: "u", finalMessageId: "a", origin: "host" as const }];
  const api: any = { list: async () => ({ items: [{ id: "c" }] }), getMessages: async () => ({ items: [
    { id: "u", text: "edited", role: "user", at: new Date(1).toISOString() },
    { id: "a", text: "reply", role: "assistant", at: new Date(2).toISOString() },
  ] }) };
  const signal = new AbortController().signal;
  expect(await findInvalidHostSources(api, turns, [], signal)).toEqual([{ conversationId: "c", allMessages: false, invalidatedMessageIds: ["u"] }]);
  api.list = async () => ({ items: [] });
  expect((await findInvalidHostSources(api, turns, [], signal))[0].allMessages).toBe(true);
  api.list = async () => { throw new Error("storage recovery pending"); };
  await expect(findInvalidHostSources(api, turns, [], signal)).rejects.toThrow("storage recovery pending");
});

it("does not invalidate from a source snapshot that changed during the audit", async () => {
  let reads = 0;
  const api: any = { list: async () => ({ items: [{ id: "c", updatedAt: ++reads }] }),
    getMessages: async () => ({ items: [] }) };
  await expect(findInvalidHostSources(api, [], [{ conversationId: "c", messageIds: ["u"],
    quoteSnippet: "source", sourceStatus: "active", provenance: "verified" }], new AbortController().signal)).rejects.toThrow("复核期间变化");
});

it("does not mistake imported evidence from another installation for deleted host messages", async () => {
  expect(await findInvalidHostSources(undefined, [], [{ conversationId: "old-host", messageIds: ["old-message"],
    quoteSnippet: "source", sourceStatus: "active", provenance: "legacy-user-attested" }], new AbortController().signal)).toEqual([]);
});
