import { expect, it } from "vitest";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { findInvalidHostSources } from "../plugins/companion-memory/src/source-reconciliation";
import { explicitLegacySources } from "../plugins/companion-memory/src/legacy-source";
const sessions: any[] = [{ id: "c", messages: [{ id: "u", role: "user", content: "喜欢茶", at: 10 }, { id: "a", role: "assistant", content: "记住了", at: 11 }] },
  { id: "d", messages: [{ id: "v", role: "user", content: "也喜欢咖啡", at: 12 }] }];
const entry: any = { id: "m", content: "饮品偏好", quote: "", triggerText: "喜欢茶", sourceAt: 10, sessionId: "c", turnId: "", pinned: false, status: "active", provenance: "legacy-user-attested",
  legacySource: { conversationId: "c", messageIds: ["u"], evidence: [{ conversationId: "d", messageId: "v", quote: "喜欢咖啡" }], contentRevision: 4 } };
function setup() {
  const data = new Map<string, any>([["memory-state", { version: 2, revision: 0, turns: [], processed: [], entries: [entry], evidence: [], profiles: { l0: {}, l1: {}, l0Locked: false } }]]);
  const storage = { get: (key: string) => structuredClone(data.get(key)), set: (key: string, value: any) => data.set(key, structuredClone(value)), rootDir: () => "unused" };
  const memory = createMemory(storage);
  memory.bindHistoricalSources({ revision: 0, bindings: [{ entryId: "m", conversationId: "c", messageId: "u", text: "喜欢茶", at: 10, sessions }] });
  return { storage, memory };
}
it.each(["edit", "delete", "regenerate", "other-session"])("旧来源绑定与重启失效：%s", async kind => {
  const { storage } = setup(), changed = structuredClone(sessions);
  if (kind === "edit") changed[0].messages[0].content += "但现在不同了";
  if (kind === "delete") changed[0].messages.shift();
  if (kind === "regenerate") changed[0].messages[1].content = "新的回复";
  if (kind === "other-session") changed[1].messages = [];
  const memory = createMemory(storage);
  const api: any = { list: async () => ({ items: changed.map(s => ({ id: s.id })) }), getMessages: async ({ conversationId }: any) => ({ items: changed.find(s => s.id === conversationId).messages.map((m: any) => ({ id: m.id, role: m.role, text: m.content, at: new Date(m.at).toISOString() })) }) };
  for (const change of await findInvalidHostSources(api, [], memory.view().evidence, new AbortController().signal)) memory.invalidateHostSources(change);
  expect(createMemory(storage).view().entries[0].status).toBe("archived");
});
it("同 ID 不同原文不能冒充核验，未绑定旧来源不响应宿主删除", () => {
  const changed = structuredClone(sessions); changed[0].messages[0].content = "不是原文";
  expect(() => explicitLegacySources(entry, changed)).toThrow();
  const { storage } = setup(), state: any = storage.get("memory-state");
  state.entries[0] = entry; state.evidence = [{ id: "e", memoryId: "m", quoteSnippet: "喜欢茶", createdAt: 10, sourceStatus: "active", provenance: "legacy-user-attested", conversationId: "c", messageIds: ["u"] }];
  storage.set("memory-state", state);
  const memory = createMemory(storage); memory.invalidateHostSources({ conversationId: "c", allMessages: true, invalidatedMessageIds: [] });
  expect(memory.view().entries[0].status).toBe("active");
});
