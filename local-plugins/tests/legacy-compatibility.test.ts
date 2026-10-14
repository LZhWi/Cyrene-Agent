import { expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createLegacyCompatibility } from "../plugins/companion-memory/src/legacy-compatibility";
import { createMaintenanceInbox } from "../plugins/companion-memory/src/maintenance-inbox";
import { createDream } from "../plugins/companion-memory/src/dream";
import type { Entry } from "../plugins/companion-memory/src/entries";

const entry = (id: string): Entry => ({ id, content: `事实${id}`, quote: "", sourceAt: 10, turnId: "", sessionId: "", pinned: false, status: "active" });
const log = (status: string, createdAt = 10) => ({ id: `log-${createdAt}`, sourceL2Id: "a", targetL2Id: "b", status, createdAt, reason: "需要核对" });
const storage = (compatibility: unknown) => {
  const values = new Map<string, any>([["memory-state", { legacyCompatibility: compatibility }]]);
  return { get: (key: string) => structuredClone(values.get(key)), set: (key: string, value: unknown) => values.set(key, structuredClone(value)), rootDir: () => "unused" } as PluginStorage;
};

it("keeps terminal conflict pairs suppressed after reload and automatic scans", () => {
  const entries = [entry("a"), entry("b")];
  const compatibility = createLegacyCompatibility({ conflictLogs: [log("candidate"), log("resolved", 20)] }, entries, 30);
  const inbox = createMaintenanceInbox(storage(compatibility));
  expect(inbox.view(entries).items).toMatchObject([{ status: "dismissed", resolverPriority: "none", stale: false }]);
  expect(inbox.addAutomatically(entries, [{ leftId: "a", rightId: "b", score: 0.99 }])).toBe(0);
});

it("quarantines broken and obsolete conflicts; no pending source becomes a writable turn", () => {
  const entries = [entry("a"), { ...entry("b"), status: "archived" as const }];
  const compatibility = createLegacyCompatibility({ conflictLogs: [log("candidate"), { ...log("pending", 20), sourceL2Id: "missing" }], pendingTurns: [{ userInput: "未核实原话" }] }, entries, 30);
  expect(compatibility.summary).toMatchObject({ openConflicts: 0, quarantinedConflicts: 2, pendingTurns: 1 });
  expect(compatibility).not.toHaveProperty("turns");
});

it("imports legacy dreams without fabricating review provenance and survives saves", async () => {
  const text = "这是从原版保留下来的长期陪伴叙事，不代表新生成的复核结果。";
  const compatibility = createLegacyCompatibility({ dreamNarratives: [{ id: "d1", text, createdAt: 10 }] }, [], 30);
  const data = storage(compatibility), dream = createDream(data);
  expect(dream.context()).toContain(text);
  expect(dream.view().reviews).toEqual([]);
  expect(dream.view().narratives[0]).toMatchObject({ origin: "legacy", createdAt: 10 });
  const entries = [entry("a"), entry("b")].map((item) => ({ ...item, status: "aging" as const }));
  const review = await dream.review({ entryIds: ["a", "b"], revision: 0 }, entries, [], 0,
    async () => "这是仅用于离线测试的新叙事草稿，用来验证保存后旧叙事不会丢失或产生伪造关联。", new AbortController().signal);
  dream.resolve({ id: review.id, action: "dismiss" }, entries, 0);
  dream.reload();
  expect(createDream(data).context()).toContain(text);
  expect(createDream(data).view().narratives[0]).not.toHaveProperty("reviewId");
});

it("preserves invalid dreams only in the source archive, not model context", () => {
  const compatibility = createLegacyCompatibility({ dreamNarratives: [{ id: "bad", text: "短", createdAt: 10 }] }, [], 30);
  expect(compatibility.summary.quarantinedDreams).toBe(1);
  expect(createDream(storage(compatibility)).context()).toBe("");
});
