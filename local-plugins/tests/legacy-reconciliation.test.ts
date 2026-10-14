import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { BUILT_IN_STICKER_DESCRIPTIONS } from "../../src/main/sticker-descriptions";
import { legacyUserText } from "../plugins/companion-memory/src/legacy-sticker-text";
import { excerptLegacySources } from "../plugins/companion-memory/src/legacy-source";
import { inspectLegacyMaintenance } from "../plugins/companion-memory/src/legacy-maintenance";
import { createLegacyImportPlan, previewLegacyMemoryFile } from "../plugins/companion-memory/src/legacy-import";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { quoteLabel } from "../plugins/companion-memory/src/entries";
const message = (id: string, content: string, at = 10) => ({ id, content, at, role: "user" as const });
const entry = (quote: string, sourceAt = 10): any => ({ id: "m", quote, triggerText: quote, sourceAt });

it("表情包采用内置描述的确定转换，不删除未知或不同表情", () => {
  for (const [id, value] of Object.entries(BUILT_IN_STICKER_DESCRIPTIONS)) expect(legacyUserText(`[sticker:${id}]`)).toBe(`（用户发送表情包：${value.phrases[0]}）`);
  expect(legacyUserText("[sticker:unknown]")).toBe("[sticker:unknown]");
  expect(legacyUserText("[sticker:playful]")).not.toBe(legacyUserText("[sticker:hugtight]"));
});
it("队列只放行已知表情传输差异，保存真实原文；改文、换表情及改时间仍隔离", () => {
  const sessions = [{ id: "c", messages: [message("u", "今天去散步[sticker:playful]"), { id: "a", content: "好的", at: 11, role: "assistant" as const }] }];
  const row = { conversationId: "c", userMessageId: "u", assistantMessageId: "a", userInput: "今天去散步（用户发送表情包：你看人家嘛）", assistantReply: "好的", userAt: 10, assistantAt: 11 };
  const inspect = (patch: any) => inspectLegacyMaintenance({ pendingTurns: [{ ...row, ...patch }] }, sessions);
  expect(inspect({}).eligible[0].user).toBe(sessions[0].messages[0].content);
  for (const patch of [{ userInput: "明天去散步（用户发送表情包：你看人家嘛）" }, { userInput: "今天去散步（用户发送表情包：来，抱抱你）" }, { userAt: 9 }, { assistantReply: "不同回复" }]) expect(inspect(patch).eligible).toEqual([]);
});
it("逐段证据须全部唯一命中、同会话且顺序一致", () => {
  const quote = "我买了一盆粉白色的文心兰……等到今年开花的时候拍给你看";
  const a = message("a", "我买了一盆粉白色的文心兰，还没有开花"), b = message("b", "等到今年开花的时候拍给你看", 20);
  const sessions = [{ id: "c", messages: [a, b] }];
  expect(excerptLegacySources(entry(quote), sessions)?.map(s => s.message.id)).toEqual(["a", "b"]);
  expect(excerptLegacySources(entry(quote + "……这是没有出现的额外断言"), sessions)).toBeUndefined();
  expect(excerptLegacySources(entry(quote), [{ id: "c", messages: [b, a] }])).toBeUndefined();
  expect(excerptLegacySources(entry(quote), [{ id: "c", messages: [a] }, { id: "d", messages: [b] }])).toBeUndefined();
  expect(excerptLegacySources(entry(quote), [{ id: "c", messages: [a, b, { ...a, id: "duplicate" }] }])).toBeUndefined();
});
it("省略插入语的逗号片段必须额外匹配原始时间，不接受纯相似文本", () => {
  const quote = "事情是这样的：当时是在高三下学期，我们班转进来一个新同学";
  const sessions = [{ id: "c", messages: [message("u", "嗯。事情是这样的：当时是在高三下学期，也就是去年九月，我们班转进来一个新同学")] }];
  expect(excerptLegacySources(entry(quote), sessions)?.[0].message.id).toBe("u");
  expect(excerptLegacySources(entry(quote, 11), sessions)).toBeUndefined();
  expect(excerptLegacySources(entry(quote.replace("高三", "高二")), sessions)).toBeUndefined();
});
it("只用已完成裁决和双向回指恢复谱系，重启后来源失效继续传递到摘要", () => {
  mkdirSync(".test-runtime", { recursive: true }); const dir = mkdtempSync(path.resolve(".test-runtime/legacy-lineage-"));
  try {
    const file = path.join(dir, "memory.json");
    const leaf = (id: string, at: number) => ({ id, content: `记忆 ${id}`, triggerText: `这是第${id}条用户原始叙述`, sourceQuote: `这是第${id}条用户原始叙述`, createdAt: at, sourceAt: at, status: "merged", mergedInto: "r" });
    const raw: any = { l0: {}, l1: {}, evidence: [], l2: [leaf("a", 10), leaf("b", 20), { id: "r", content: "裁决结果", triggerText: "裁决理由不是用户原文", createdAt: 30, status: "active" }, { id: "s", content: "更高层摘要", createdAt: 40, status: "active", isSummary: true, subEntryIds: ["r"] }],
      conflictLogs: [{ id: "log", createdAt: 30, sourceL2Id: "a", targetL2Id: "b", status: "resolved", resolverStatus: "resolved", resolutionType: "context_difference", resolutionMemoryId: "r", reason: "审计理由" }] };
    const plan = () => { writeFileSync(file, JSON.stringify(raw)); return createLegacyImportPlan(file, previewLegacyMemoryFile(file).sourceHash); };
    const imported = plan(); expect(imported.entries.find(e => e.id === "r")?.legacySource?.parentEntryIds).toEqual(["a", "b"]);
    const data = new Map<string, any>(), storage = { get: (k: string) => structuredClone(data.get(k)), set: (k: string, v: any) => data.set(k, structuredClone(v)), rootDir: () => "unused" };
    const memory = createMemory(storage); memory.importLegacy(imported, { revision: 0 });
    memory.bindHistoricalSources({ revision: 1, bindings: ["a", "b"].map((id, i) => ({ entryId: id, conversationId: "c", messageId: id, text: `这是第${id}条用户原始叙述`, at: 10 + i * 10 })) });
    expect(memory.view().entries.filter(e => ["r", "s"].includes(e.id)).every(e => e.provenance === "derived-source-verified")).toBe(true);
    const restarted = createMemory(storage); restarted.invalidateHostSources({ conversationId: "c", allMessages: false, invalidatedMessageIds: ["a"] });
    expect(restarted.view().entries.filter(e => ["r", "s"].includes(e.id)).every(e => e.status === "archived")).toBe(true);
    raw.conflictLogs[0].shouldAskUser = true; expect(plan().entries.find(e => e.id === "r")?.legacySource?.parentEntryIds).toBeUndefined();
    raw.conflictLogs[0].shouldAskUser = false; delete raw.l2[0].mergedInto; expect(plan().entries.find(e => e.id === "r")?.legacySource?.parentEntryIds).toBeUndefined();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it("已绑定来源展示真实原文，不把旧省略片段称作逐字原话", () => {
  expect(quoteLabel({ ...entry("实际用户完整原文"), triggerText: "旧概括", turnId: "host-message:u", provenance: "verified" })).toContain("实际用户完整原文");
});
