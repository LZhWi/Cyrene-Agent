import { expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { createLegacyImportPlan } from "../plugins/companion-memory/src/legacy-import";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { createNativeHistory } from "../plugins/companion-memory/src/native-history";
import { findInvalidHostSources } from "../plugins/companion-memory/src/source-reconciliation";
import { inspectLegacyMaintenance } from "../plugins/companion-memory/src/legacy-maintenance";
import { createLegacyContextPlan, commitLegacyContext } from "../plugins/companion-memory/src/legacy-context-import";
import { createEntityGraph } from "../plugins/companion-memory/src/entity-graph";
import { createRelationshipLog } from "../plugins/companion-memory/src/relationship-context";
import { createSocialContext } from "../plugins/companion-memory/src/social-context";

it.runIf(Boolean(process.env.CYRENE_CONTEXT_REPLAY_DIR))("真实记忆、上下文、来源绑定、队列和重启整体隔离回放", async () => {
  const root = path.resolve("../.test-runtime/chat-replay-20261010"), output = process.env.CYRENE_CONTEXT_REPLAY_DIR!;
  const file = path.join(root, "memory.json"), bytes = readFileSync(file), raw = JSON.parse(bytes.toString("utf8"));
  const plan = createLegacyImportPlan(file, createHash("sha256").update(bytes).digest("hex"), true, true);
  const sessions = readdirSync(path.join(root, "snapshot/sessions")).map(name => {
    const session = JSON.parse(readFileSync(path.join(root, "snapshot/sessions", name), "utf8"));
    return { id: session.id, messages: session.messages.filter((m: any) => ["user", "assistant", "model"].includes(m.role)).map((m: any) => ({ id: m.id, role: m.role === "model" ? "assistant" : m.role, content: m.content, at: typeof m.at === "number" ? m.at : Date.parse(m.at) })) };
  });
  let live = structuredClone(sessions), models = 0;
  const data = new Map<string, any>(), storage = { get: (key: string) => structuredClone(data.get(key)), set: (key: string, value: any) => data.set(key, structuredClone(value)), rootDir: () => output };
  const noModel = async () => { models++; throw new Error("model forbidden"); };
  const api: any = { list: async () => ({ items: live.map(s => ({ id: s.id })) }), getMessages: async ({ conversationId }: any) => ({ items: live.find(s => s.id === conversationId)!.messages.map((m: any) => ({ id: m.id, role: m.role, text: m.content, at: new Date(m.at).toISOString() })) }) };
  let memory = createMemory(storage); memory.importLegacy(plan, { revision: 0 });
  const context = createLegacyContextPlan(output, sessions); commitLegacyContext(storage, context, context.sourceHash);
  const graph = createEntityGraph(storage), relationship = createRelationshipLog(storage); relationship.reconcile([]);
  const social = createSocialContext(storage, noModel);
  expect(graph.view().count).toBe(context.summary.entities); expect(relationship.view().entries).toBe(context.summary.relationshipEntries); expect(social.view().total).toBe(context.summary.socialAtoms);
  const history = createNativeHistory({ deps: { conversations: api, llm: { generateText: noModel } } } as any, memory);
  let bound = 0;
  for (let batch = 0; batch < 5; batch++) {
    const preview = await history.preview({ conversationIds: sessions.map(s => s.id) }, new AbortController().signal);
    if (!preview.unique) break;
    bound += (await history.applyUnique({ previewId: preview.id }, new AbortController().signal)).bound;
  }
  expect(bound).toBeGreaterThan(0);
  const before = memory.view();
  expect((await findInvalidHostSources(api, [], [...before.evidence, ...context.sourceEvidence], new AbortController().signal)).length).toBe(0);
  const unresolvedFile = path.join(output, "unresolved-diagnostic-private.json");
  if (existsSync(unresolvedFile)) {
    const prior = JSON.parse(readFileSync(unresolvedFile, "utf8"));
    const resolved = prior.memories.map((old: any) => {
      const current = before.entries.find(e => e.id === old.id)!;
      expect(["verified", "derived-source-verified"]).toContain(current.provenance);
      return { id: old.id, provenance: current.provenance, parentEntryIds: current.legacySource?.parentEntryIds, summary: Boolean(current.isSummary),
        sourceAtCorrected: current.sourceAt !== old.sourceAt, evidenceMessages: before.evidence.filter(e => e.memoryId === old.id && e.provenance === "verified").reduce((count, e) => count + (e.messageIds?.length ?? 0), 0) };
    });
    writeFileSync(path.join(output, "unresolved-fix-replay-result.json"), JSON.stringify({ resolved, social: context.summary, mainModelCalls: models }, null, 2));
  }
  const maintenance = inspectLegacyMaintenance(raw, sessions);
  const restored = memory.restoreLegacyPending(maintenance.eligible, memory.view().revision);
  const restarted = createMemory(storage);
  expect(restarted.restoreLegacyPending(maintenance.eligible, restarted.view().revision).restored).toBe(0);
  const frozen = structuredClone(data), outcomes: any[] = [];
  const selected = before.evidence.find(e => e.provenance === "verified" && e.messageIds!.length > 1)!;
  expect(Boolean(selected)).toBe(true);
  for (const kind of ["edit", "delete", "regenerate", "delete-session"]) {
    data.clear(); for (const [key, value] of frozen) data.set(key, structuredClone(value)); live = structuredClone(sessions);
    const session = live.find(s => s.id === selected.conversationId)!;
    if (kind === "edit") session.messages.find((m: any) => m.id === selected.messageIds![0])!.content += "（隔离回放更改）";
    if (kind === "delete") session.messages = session.messages.filter((m: any) => m.id !== selected.messageIds![0]);
    if (kind === "regenerate") session.messages.find((m: any) => m.id === selected.messageIds![1])!.content = "隔离回放新回复";
    if (kind === "delete-session") live = live.filter(s => s.id !== selected.conversationId);
    memory = createMemory(storage);
    const changes = await findInvalidHostSources(api, memory.view().turns, memory.view().evidence, new AbortController().signal);
    for (const change of changes) memory.invalidateHostSources(change);
    const after = createMemory(storage).view();
    expect(after.entries.find(e => e.id === selected.memoryId)?.status).toBe("archived");
    outcomes.push({ kind, changes: changes.length, archived: true });
  }
  expect(models).toBe(0);
  writeFileSync(path.join(output, "full-replay-result.json"), JSON.stringify({ sourceEntries: raw.l2.length, idFieldsPresent: raw.l2.filter((e: any) => e.sourceMessageIds !== undefined).length,
    nonemptyIdFields: raw.l2.filter((e: any) => e.sourceMessageIds?.length).length, bound,
    provenanceCounts: Object.fromEntries([...new Set(before.entries.map(e => e.provenance))].map(p => [p!, before.entries.filter(e => e.provenance === p).length])),
    context: context.summary, maintenance: { eligible: maintenance.eligible.length, rejected: maintenance.rejected, historicalRoundCount: maintenance.historicalRoundCount, restored: restored.restored }, outcomes, models }, null, 2));
});
