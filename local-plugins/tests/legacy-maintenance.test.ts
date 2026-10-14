import { expect, it } from "vitest";
import { inspectLegacyMaintenance } from "../plugins/companion-memory/src/legacy-maintenance";
import { createMemory } from "../plugins/companion-memory/src/memory";
const sessions: any[] = [{ id: "c", messages: [{ id: "u", role: "user", content: "茶", at: 1 }, { id: "a", role: "assistant", content: "好", at: 2 }] }];
const pending = { conversationId: "c", userMessageId: "u", assistantMessageId: "a", userInput: "茶", assistantReply: "好", userAt: 1, assistantAt: 2 };
it("只恢复完整核验的队列，重启重复恢复不重复计数或触发模型", () => {
  const plan = inspectLegacyMaintenance({ pendingTurns: [pending, pending, { ...pending, assistantReply: "旧回复" }, { ...pending, sourceUserVersion: "unsupported" }], l1: { roundCount: 1234 } }, sessions);
  expect(plan.eligible.length).toBe(1); expect(plan.rejected.map(r => r.reason)).toEqual(["duplicate", "source-changed", "unsupported-source-version"]);
  const data = new Map<string, any>(), storage = { get: (key: string) => structuredClone(data.get(key)), set: (key: string, value: any) => data.set(key, structuredClone(value)), rootDir: () => "unused" };
  const memory = createMemory(storage);
  expect(memory.restoreLegacyPending(plan.eligible, 0)).toEqual({ restored: 1, pending: 1 });
  const restarted = createMemory(storage);
  expect(restarted.restoreLegacyPending(plan.eligible, restarted.view().revision)).toEqual({ restored: 0, pending: 1 });
  expect(() => restarted.restoreLegacyPending([{ ...plan.eligible[0], assistant: "不同版本" }], restarted.view().revision)).toThrow();
  expect(restarted.view().turns.length).toBe(1);
});
