import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { FRESHNESS_MS, profileContext, emptyProfiles } from "../plugins/companion-memory/src/profiles";

function fixture() {
  const map = new Map<string, any>();
  const storage: PluginStorage = { get: (k) => structuredClone(map.get(k)), set: (k,v) => { map.set(k, structuredClone(v)); }, rootDir: () => "unused" };
  const memory = createMemory(storage);
  const now = Date.now();
  for (let i = 0; i < 10; i++) memory.ingest({ id: `t${i}`, sessionId: "s", user: "请叫我小林，我是设计师，最近计划学画画", assistant: "好的", userAt: now - 1000 + i, assistantAt: now - 999 + i });
  const candidate = { layer: "L0", field: "preferredName", content: "小林", quote: "请叫我小林", turnId: "t0", certainty: "explicit", attribution: "user_explicit" };
  return { memory, storage, map, candidate };
}
describe("L0/L1/L2 分层与编辑边界", () => {
  it("分层提取并注入，画像不是查询关键词命中才显示", async () => {
    const { memory, candidate } = fixture();
    await memory.maintain(async () => JSON.stringify([candidate, { ...candidate, layer: "L1", field: "recentGoals", content: "计划学画画", quote: "最近计划学画画" }, { ...candidate, layer: "L2", content: "用户提到学习计划" }]), new AbortController().signal);
    expect(memory.view().profiles.l0.preferredName?.content).toBe("小林");
    expect(memory.view().profiles.l1.recentGoals?.content).toBe("计划学画画");
    expect(memory.view().entries).toHaveLength(1);
    expect(memory.search("你好")).toContain("[用户画像]");
    expect(memory.search("你好")).toContain("[近期状态]");
  });
  it("锁定禁止自动改 L0，允许手动编辑；非法字段拒绝", async () => {
    const { memory, candidate } = fixture();
    memory.lockProfile({ locked: true, revision: memory.view().revision });
    await memory.maintain(async () => JSON.stringify([candidate]), new AbortController().signal);
    expect(memory.view().profiles.l0).toEqual({});
    memory.editProfile({ layer: "L0", field: "preferredName", content: "手动名字", revision: memory.view().revision });
    expect(memory.view().profiles.l0.preferredName?.origin).toBe("user-edit");
    expect(() => memory.editProfile({ layer: "L0", field: "__proto__", content: "x", revision: memory.view().revision })).toThrow("白名单");
  });
  it("不明确或助手推断的 L0 不落库；无证据的绝对化表述拒绝", async () => {
    const { memory, candidate } = fixture();
    await expect(memory.maintain(async () => JSON.stringify([{ ...candidate, content: "永远叫小林" }]), new AbortController().signal)).rejects.toThrow("绝对化");
    expect(memory.view().pending).toBe(10);
    await memory.maintain(async () => JSON.stringify([{ ...candidate, attribution: "assistant_inferred" }]), new AbortController().signal);
    expect(memory.view().profiles.l0).toEqual({});
  });
  it("L1 30 天边界按来源时间而非读取/回填时刻", () => {
    const profiles = emptyProfiles();
    profiles.l1.recentGoals = { content: "过去的目标", sourceAt: 1000, quote: "", sessionId: "", turnId: "", origin: "extracted" };
    expect(profileContext(profiles, 1000 + FRESHNESS_MS - 1).join()).toContain("过去的目标");
    expect(profileContext(profiles, 1000 + FRESHNESS_MS)).toEqual([]);
    expect(profileContext(profiles, 999)).toEqual([]);
  });
  it("提取期间手动修改不被迟到结果覆盖，批次不消耗", async () => {
    const { memory, candidate } = fixture(); let resolve!: (s: string) => void;
    const run = memory.maintain(() => new Promise((r) => { resolve = r; }), new AbortController().signal);
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    memory.editProfile({ layer: "L0", field: "preferredName", content: "最新手动名字", revision: memory.view().revision });
    resolve(JSON.stringify([candidate])); await expect(run).rejects.toThrow("刷新");
    expect(memory.view().pending).toBe(10); expect(memory.view().profiles.l0.preferredName?.content).toBe("最新手动名字");
  });
  it("旧版本先备份再迁移；失败不覆盖原状态", () => {
    const { storage, map } = fixture();
    const old = { version: 1, turns: [], processed: [], entries: [{ id: "e", content: "原记忆", quote: "原文", sourceAt: 1000, turnId: "t", sessionId: "s", pinned: false }] };
    map.set("memory-state", old);
    const memory = createMemory(storage);
    expect(map.get("memory-state").version).toBe(1);
    memory.lockProfile({ locked: true, revision: 0 });
    expect(map.get("memory-state-v1-backup")).toEqual(old);
    expect(map.get("memory-state").version).toBe(2);
    expect(memory.view().entries[0].content).toBe("原记忆");
  });
  it("L2 置顶/归档/恢复与编辑保持证据，过期版本拒绝写入", async () => {
    const { memory, candidate } = fixture();
    await memory.maintain(async () => JSON.stringify([{ ...candidate, layer: "L2" }]), new AbortController().signal);
    const e = memory.view().entries[0], revision = memory.view().revision;
    memory.editEntry({ ...e, content: "用户修改摘要", pinned: true, revision });
    expect(memory.search("无关键词")).toContain("用户修改摘要");
    expect(memory.view().entries[0].quote).toBe(e.quote);
    expect(memory.search("无关键词")).toContain("摘要由用户修改");
    expect(() => memory.editEntry({ ...e, revision })).toThrow("刷新");
    memory.editEntry({ ...memory.view().entries[0], status: "archived", revision: memory.view().revision });
    expect(memory.search("无关键词")).not.toContain("[记忆");
    memory.editEntry({ ...memory.view().entries[0], status: "active", revision: memory.view().revision });
    expect(memory.search("无关键词")).toContain("[记忆");
  });
  it("画像反思只把有来源、高置信的既有字段变化加入待确认列表", async () => {
    const { memory, candidate } = fixture();
    await memory.maintain(async () => JSON.stringify([candidate]), new AbortController().signal);
    const at = Date.now() - 100;
    for (let index = 10; index < 20; index++) memory.ingest({ id: `t${index}`, sessionId: "s", user: "请叫我小李", assistant: "好的", userAt: at + index, assistantAt: at + index + 1 });
    await memory.maintain(async () => JSON.stringify([{ ...candidate, layer: "L2", content: "用户后来明确希望称作小李", quote: "请叫我小李", turnId: "t10" }]), new AbortController().signal);
    const generate = vi.fn().mockResolvedValue('[{"layer":"L0","field":"preferredName","content":"小李","sourceCode":"P1","confidence":0.92,"reason":"较新的明确称呼证据"}]');
    const result = await memory.reviewProfiles(generate, new AbortController().signal);
    expect(result).toEqual({ suggested: 1 });
    const change = memory.view().profileChanges[0];
    expect(change).toMatchObject({ layer: "L0", field: "preferredName", status: "pending", before: { content: "小林" }, after: { content: "小李", quote: "请叫我小李" } });
    expect(memory.view().profiles.l0.preferredName?.content).toBe("小林");
    memory.resolveProfileChange({ id: change.id, action: "accept", revision: memory.view().revision });
    expect(memory.view().profiles.l0.preferredName?.content).toBe("小李");
    expect(generate.mock.calls[0][0]).not.toContain(memory.view().entries[0].id);
  });

  it("画像反思不新增空字段，低置信、无效来源和锁定 L0 均不产生候选", async () => {
    const { memory, candidate } = fixture();
    await memory.maintain(async () => JSON.stringify([candidate, { ...candidate, layer: "L2" }]), new AbortController().signal);
    const low = await memory.reviewProfiles(async () => '[{"layer":"L0","field":"occupation","content":"设计师","sourceCode":"P1","confidence":0.99,"reason":"当前字段为空"},{"layer":"L0","field":"preferredName","content":"小李","sourceCode":"P99","confidence":0.99,"reason":"无效来源"}]', new AbortController().signal);
    expect(low).toEqual({ suggested: 0 });
    memory.lockProfile({ locked: true, revision: memory.view().revision });
    const locked = await memory.reviewProfiles(async () => '[{"layer":"L0","field":"preferredName","content":"小李","sourceCode":"P1","confidence":0.99,"reason":"锁定字段"}]', new AbortController().signal);
    expect(locked).toEqual({ suggested: 0 }); expect(memory.view().profileChanges).toEqual([]);
  });
  it("反思候选保留来源快照，来源改变后拒绝采用；未变化时采用可严格撤销", async () => {
    const { memory, candidate, storage } = fixture();
    await memory.maintain(async () => JSON.stringify([candidate]), new AbortController().signal);
    const at = Date.now() - 100;
    for (let index = 10; index < 20; index++) memory.ingest({ id: `t${index}`, sessionId: "s", user: "现在请叫我小李", assistant: "好的", userAt: at + index, assistantAt: at + index + 1 });
    await memory.maintain(async () => JSON.stringify([{ ...candidate, layer: "L2", content: "用户明确要求称作小李", quote: "现在请叫我小李", turnId: "t10" }]), new AbortController().signal);
    await memory.reviewProfiles(async () => '[{"layer":"L0","field":"preferredName","content":"小李","sourceCode":"P1","confidence":0.96,"reason":"较新称呼"}]', new AbortController().signal);
    const review = memory.view().profileChanges[0];
    expect(review.reflection).toMatchObject({ kind: "turn", confidence: 0.96, entry: { id: memory.view().entries[0].id } });
    expect(createMemory(storage).view().profileChanges[0].reflection).toEqual(review.reflection);
    memory.editEntry({ ...memory.view().entries[0], content: "人工改过的摘要", revision: memory.view().revision });
    expect(() => memory.resolveProfileChange({ id: review.id, action: "accept", revision: memory.view().revision })).toThrow("来源已变化");
    expect(memory.view().profiles.l0.preferredName?.content).toBe("小林");

    const fresh = fixture();
    await fresh.memory.maintain(async () => JSON.stringify([fresh.candidate]), new AbortController().signal);
    const original = fresh.memory.view().profiles.l0.preferredName;
    for (let index = 10; index < 20; index++) fresh.memory.ingest({ id: `t${index}`, sessionId: "s", user: "现在请叫我小李", assistant: "好的", userAt: at + index, assistantAt: at + index + 1 });
    await fresh.memory.maintain(async () => JSON.stringify([{ ...fresh.candidate, layer: "L2", content: "用户明确要求称作小李", quote: "现在请叫我小李", turnId: "t10" }]), new AbortController().signal);
    const restarted = createMemory(fresh.storage);
    await restarted.reviewProfiles(async () => '[{"layer":"L0","field":"preferredName","content":"小李","sourceCode":"P1","confidence":0.96,"reason":"候选"}]', new AbortController().signal);
    const id = restarted.view().profileChanges[0].id;
    restarted.resolveProfileChange({ id, action: "accept", revision: restarted.view().revision });
    expect(restarted.view().profiles.l0.preferredName?.content).toBe("小李");
    restarted.resolveProfileChange({ id, action: "undo-accept", revision: restarted.view().revision });
    expect(restarted.view().profiles.l0.preferredName).toEqual(original);
    expect(restarted.view().profileChanges[0].status).toBe("undone");
    expect(() => restarted.resolveProfileChange({ id, action: "undo-accept", revision: restarted.view().revision })).toThrow("操作无效");
  });

  it("未核验旧条目与已编辑条目均不进入反思模型", async () => {
    const { memory, candidate, storage, map } = fixture();
    await memory.maintain(async () => JSON.stringify([candidate, { ...candidate, layer: "L2" }]), new AbortController().signal);
    const original = map.get("memory-state"), entry = original.entries[0];
    map.set("memory-state", { ...original, entries: [{ ...entry, provenance: "legacy-unverified", quote: "请叫我小林" }] });
    const legacy = createMemory(storage), generate = vi.fn(async () => "[]");
    expect(await legacy.reviewProfiles(generate, new AbortController().signal)).toEqual({ suggested: 0 });
    expect(generate).not.toHaveBeenCalled();
    map.set("memory-state", { ...original, entries: [{ ...entry, editedAt: Date.now() }] });
    const edited = createMemory(storage);
    expect(await edited.reviewProfiles(generate, new AbortController().signal)).toEqual({ suggested: 0 });
    expect(generate).not.toHaveBeenCalled();
    map.set("memory-state", { ...original, entries: [{ ...entry, quote: "这段话不存在于用户轮次" }] });
    const ungrounded = createMemory(storage);
    expect(await ungrounded.reviewProfiles(generate, new AbortController().signal)).toEqual({ suggested: 0 });
    expect(generate).not.toHaveBeenCalled();
  });
  it("已核验历史消息可作为人工反思来源，证据变化后拒绝采用", async () => {
    const { memory, candidate, storage, map } = fixture();
    await memory.maintain(async () => JSON.stringify([candidate]), new AbortController().signal);
    const original = map.get("memory-state"), at = Date.now() - 100;
    const entry = { id: "bound-memory", content: "用户希望改称小李", quote: "现在请叫我小李", sourceAt: at, turnId: "host-message:m1", sessionId: "native-chat", pinned: false, status: "active", provenance: "verified" };
    const evidence = { id: "ev1", memoryId: entry.id, quoteSnippet: entry.quote, createdAt: Date.now(), sourceStatus: "active", provenance: "verified", conversationId: entry.sessionId, messageIds: ["m1"] };
    map.set("memory-state", { ...original, entries: [entry], evidence: [evidence] });
    const bound = createMemory(storage), generate = vi.fn(async () => '[{"layer":"L0","field":"preferredName","content":"小李","sourceCode":"P1","confidence":0.95,"reason":"已核验用户消息"}]');
    expect(await bound.reviewProfiles(generate, new AbortController().signal)).toEqual({ suggested: 1 });
    const change = bound.view().profileChanges[0];
    expect(change.reflection).toMatchObject({ kind: "verified-evidence", evidence: { id: "ev1" } });
    const saved = map.get("memory-state");
    map.set("memory-state", { ...saved, evidence: [{ ...evidence, sourceStatus: "archived" }] });
    const changed = createMemory(storage);
    expect(() => changed.resolveProfileChange({ id: change.id, action: "accept", revision: changed.view().revision })).toThrow("证据已变化");
    expect(changed.view().profiles.l0.preferredName?.content).toBe("小林");
  });
});
