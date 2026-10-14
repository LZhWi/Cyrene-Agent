import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createLegacyContextPlan, commitLegacyContext } from "../plugins/companion-memory/src/legacy-context-import";
import { createEntityGraph } from "../plugins/companion-memory/src/entity-graph";
import { createRelationshipLog } from "../plugins/companion-memory/src/relationship-context";
import { createSocialContext } from "../plugins/companion-memory/src/social-context";
import { legacyContextState } from "../plugins/companion-memory/src/legacy-context-state";
const noModel = async () => { throw new Error("model forbidden"); };
function storage() {
  const data = new Map<string, any>();
  return { data, get: (key: string) => structuredClone(data.get(key)), set: (key: string, value: any) => data.set(key, structuredClone(value)), rootDir: () => "unused" };
}
it("上下文一次提交，重启保留关系/日志/时间；未核验社交来源不注入", async () => {
  mkdirSync(".test-runtime", { recursive: true }); const dir = mkdtempSync(path.resolve(".test-runtime/context-import-"));
  try {
    const entity = (id: string) => ({ id, name: id, type: "person", aliases: [], mentionCount: 1, firstMentionedAt: 1, lastMentionedAt: 2 });
    writeFileSync(path.join(dir, "entity-graph.json"), JSON.stringify({ entities: [entity("Alice"), entity("Bob")], relations: [{ id: "r", sourceId: "Alice", targetId: "Bob", relation: "friend_of", confidence: 1, strength: 2 }] }));
    writeFileSync(path.join(dir, "relationship-log.json"), JSON.stringify({ entries: [{ id: "old", date: "2026-01-01", createdAt: 1, userText: "茶", assistantText: "好", userMood: "平稳", relationshipSignal: "关心", nextCareCue: "茶", channel: "desktop", cyreneFeeling: "开心" }], dailySummaries: [{ date: "2026-01-01", updatedAt: 2, summary: "喝茶", nextCareCue: "茶" }] }));
    writeFileSync(path.join(dir, "chat-social-atoms.json"), JSON.stringify({ version: 1, atoms: [{ id: "s", conversationId: "c", type: "short_term", content: "茶", evidenceTurnId: "u", evidenceQuote: "茶", createdAt: 1, updatedAt: 1, expiresAt: 99999, status: "active" }] }));
    writeFileSync(path.join(dir, "memory-dream.json"), JSON.stringify({ lastDreamAt: 123, logs: [{ id: "log" }] }));
    const plan = createLegacyContextPlan(dir), store = storage();
    expect(plan.summary).toMatchObject({ relations: 1, unboundSocialAtoms: 1, dreamLogs: 1 });
    expect(() => commitLegacyContext(store, plan, "wrong")).toThrow(); expect(store.data.size).toBe(0);
    commitLegacyContext(store, plan, plan.sourceHash);
    const graph = createEntityGraph(store); graph.ingest([{ name: "Alice", type: "person" }]);
    expect(createEntityGraph(store).search("Alice")).toContain("friend_of");
    const log = createRelationshipLog(store); log.reconcile([]); expect(log.view()).toEqual({ entries: 1, dailySummaries: 1 });
    expect(createRelationshipLog(store).context()).toContain("喝茶");
    expect(legacyContextState<any>(store, "relationship-log").entries[0]).toMatchObject({ channel: "desktop", cyreneFeeling: "开心" });
    expect(legacyContextState<any>(store, "auto-dream-state").lastCompletedAt).toBe(123);
    expect(await createSocialContext(store, noModel, undefined, () => 5).retrieve("c", "茶", new AbortController().signal)).toEqual([]);
    expect(() => commitLegacyContext(store, plan, plan.sourceHash)).toThrow();
    const bound = createLegacyContextPlan(dir, [{ id: "c", messages: [{ id: "u", role: "user", content: "茶", at: 1 }] }]);
    expect(bound.summary.verifiedSocialAtoms).toBe(1);
    const conflict = storage(); conflict.set("entity-graph", { version: 1, entities: [] });
    expect(() => commitLegacyContext(conflict, plan, plan.sourceHash)).toThrow(); expect(conflict.data.size).toBe(1);
    writeFileSync(path.join(dir, "entity-graph.json"), JSON.stringify({ entities: [], relations: [{ id: "r", sourceId: "absent", targetId: "also absent" }] }));
    expect(() => createLegacyContextPlan(dir)).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.runIf(Boolean(process.env.CYRENE_CONTEXT_REPLAY_DIR))("真实数据副本迁移、重启与隔离校验", () => {
  const plan = createLegacyContextPlan(process.env.CYRENE_CONTEXT_REPLAY_DIR!), store = storage();
  commitLegacyContext(store, plan, plan.sourceHash);
  const graph = createEntityGraph(store), relationship = createRelationshipLog(store); relationship.reconcile([]);
  const social = createSocialContext(store, noModel);
  expect(graph.view().count).toBe(plan.summary.entities);
  expect(relationship.view().entries).toBe(plan.summary.relationshipEntries);
  expect(social.view().total).toBe(plan.summary.socialAtoms);
  expect(social.view().unbound).toBe(plan.summary.socialAtoms);
  writeFileSync(path.join(process.env.CYRENE_CONTEXT_REPLAY_DIR!, "replay-result.json"), JSON.stringify({ summary: plan.summary, sourceHash: plan.sourceHash, modelCalls: 0, restart: true }, null, 2));
});
