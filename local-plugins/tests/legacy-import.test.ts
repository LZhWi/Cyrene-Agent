import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory } from "../plugins/companion-memory/src/memory";
import { createDmae } from "../plugins/companion-memory/src/dmae";
import { createLifecycle } from "../plugins/companion-memory/src/lifecycle";
import { analyzeLegacyMemory, createLegacyImportPlan, defaultLegacyMemoryPath, previewLegacyMemoryFile } from "../plugins/companion-memory/src/legacy-import";

const facets = { primaryKind: "preference", retrievalKinds: ["preference"], source: "model", pendingClassification: false };
const entry = (patch: Record<string, unknown> = {}) => ({ id: "m1", content: "用户喜欢茶", createdAt: 10, status: "active", sourceQuote: "喜欢茶", sourceConversationId: "s1", facets, ...patch });
const evidence = (patch: Record<string, unknown> = {}) => ({ id: "e1", memoryId: "m1", quoteSnippet: "喜欢茶", createdAt: 10, sourceStatus: "active", ...patch });
const source = (patch: Record<string, unknown> = {}) => ({ l0: { preferredName: "小林", occupation: "", longTermInterests: "", language: "", permanentNote: "", nickname: "旧昵称", updatedAt: 10 }, l1: { recentGoals: "学习", recentPreferences: "", currentProject: "", generatedAt: 10 }, l2: [entry()], evidence: [evidence()], ...patch });
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const parent = path.resolve(".test-runtime");
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("导入预检只返回固定聚合字段并识别安全结构", () => {
  const preview = analyzeLegacyMemory(source(), "hash", 123);
  expect(preview).toEqual(expect.objectContaining({ sourceHash: "hash", sourceBytes: 123, canImport: true }));
  expect(preview.entries).toMatchObject({ total: 1, valid: 1, invalid: 0, missingSourceAt: 1, missingSourceReference: 0, brokenRelations: 0 });
  expect(preview.evidence).toMatchObject({ total: 1, valid: 1, invalid: 0, orphaned: 0 });
  expect(preview.facets).toMatchObject({ present: 1, valid: 1, invalid: 0, pending: 0 });
  expect(preview.profiles).toMatchObject({ l0: 1, l1: 1, invalid: 0, ignoredLegacyFields: 1 });
  expect(JSON.stringify(preview)).not.toContain("用户喜欢茶");
});

it("重复标识、非法状态、断裂关系和孤立证据关闭导入门禁", () => {
  const preview = analyzeLegacyMemory(source({
    l2: [entry({ supersededBy: "missing" }), entry({ content: "重复", status: "mystery" })],
    evidence: [evidence({ memoryId: "missing" }), evidence()],
  }));
  expect(preview.canImport).toBe(false);
  expect(preview.entries).toMatchObject({ duplicateIds: 1, invalid: 1, brokenRelations: 1 });
  expect(preview.evidence.orphaned).toBe(1);
  expect(preview.warnings).toContain("检测到结构或关联问题，当前禁止导入。");
});

it("文件预检限制绝对 memory.json 普通文件，且不改源文件", () => {
  const dir = temporaryDirectory("legacy-preview-");
  const file = path.join(dir, "memory.json"), text = JSON.stringify(source());
  writeFileSync(file, text);
  const preview = previewLegacyMemoryFile(file);
  expect(preview.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  expect(preview.sourceBytes).toBe(Buffer.byteLength(text));
  expect(() => previewLegacyMemoryFile("memory.json")).toThrow("绝对路径");
  expect(() => previewLegacyMemoryFile(path.join(dir, "other.json"))).toThrow("绝对路径");
});

it("确认计划要求哈希一致，并保守映射画像、L2与证据来源状态", () => {
  const dir = temporaryDirectory("legacy-plan-"), file = path.join(dir, "memory.json");
  writeFileSync(file, JSON.stringify(source()));
  const preview = previewLegacyMemoryFile(file), plan = createLegacyImportPlan(file, preview.sourceHash);
  expect(plan.entries[0]).toMatchObject({ id: "m1", provenance: "legacy-unverified", sessionId: "s1" });
  expect(plan.entries[0].facets).toEqual(facets);
  expect(plan.evidence[0]).toMatchObject({ id: "e1", provenance: "legacy-unverified" });
  expect(plan.profiles.l0.preferredName).toMatchObject({ content: "小林", origin: "legacy-import", sourceAt: 10 });
  expect(plan.profiles.l0).not.toHaveProperty("nickname");
  const attested = createLegacyImportPlan(file, preview.sourceHash, true);
  expect(attested.sourceAttested).toBe(true);
  expect(attested.entries[0].provenance).toBe("legacy-user-attested");
  expect(attested.evidence[0].provenance).toBe("legacy-user-attested");
  expect(attested.profiles.l0.preferredName?.origin).toBe("legacy-user-attested");
  writeFileSync(file, JSON.stringify(source({ l2: [entry({ content: "源已变化" })] })));
  expect(() => createLegacyImportPlan(file, preview.sourceHash)).toThrow("已变化");
});

it("压缩摘要保留子项谱系并从叶子推导来源时间包络", () => {
  const dir = temporaryDirectory("legacy-summary-"), file = path.join(dir, "memory.json");
  const leafA = entry({ id: "a", content: "事件开始", sourceAt: 10, sourceEndAt: 12 });
  const leafB = entry({ id: "b", content: "事件结果", sourceAt: 40 });
  const summary = entry({ id: "s", content: "事件总结", sourceAt: 999, isSummary: true, subEntryIds: ["a", "b"] });
  writeFileSync(file, JSON.stringify(source({ l2: [leafA, leafB, summary], evidence: [] })));
  const preview = previewLegacyMemoryFile(file);
  expect(preview).toMatchObject({ canImport: true, entries: { summaries: 1, summaryLineageIssues: 0 } });
  const plan = createLegacyImportPlan(file, preview.sourceHash), imported = plan.entries.find((item) => item.id === "s");
  expect(imported).toMatchObject({ isSummary: true, subEntryIds: ["a", "b"], sourceAt: 10, sourceEndAt: 40, provenance: "legacy-unverified" });
});

it("压缩摘要缺子项或循环时关闭导入门禁，不使用摘要自身时间兜底", () => {
  const missing = analyzeLegacyMemory(source({ l2: [entry({ id: "s", isSummary: true, subEntryIds: ["missing"] })], evidence: [] }));
  expect(missing).toMatchObject({ canImport: false, entries: { summaries: 1, summaryLineageIssues: 1 } });
  const cycle = analyzeLegacyMemory(source({ l2: [entry({ id: "a", isSummary: true, subEntryIds: ["b"] }), entry({ id: "b", isSummary: true, subEntryIds: ["a"] })], evidence: [] }));
  expect(cycle).toMatchObject({ canImport: false, entries: { summaries: 2, summaryLineageIssues: 2 } });
});

it("只向空插件库导入，先保存备份，状态提交失败不在内存中假装成功", () => {
  const dir = temporaryDirectory("legacy-commit-"), file = path.join(dir, "memory.json");
  writeFileSync(file, JSON.stringify(source()));
  const preview = previewLegacyMemoryFile(file), plan = createLegacyImportPlan(file, preview.sourceHash), map = new Map<string, any>();
  const storage: PluginStorage = { get: (key) => structuredClone(map.get(key)), set: (key, value) => { map.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  const memory = createMemory(storage), result = memory.importLegacy(plan, { revision: 0 });
  expect(result).toMatchObject({ importedEntries: 1, importedEvidence: 1, importedProfiles: 2, revision: 1 });
  expect(map.get("memory-state-pre-legacy-import-backup")).toMatchObject({ entries: [], revision: 0 });
  expect(memory.view().entries[0].provenance).toBe("legacy-unverified");
  expect(memory.search("茶")).toContain("旧系统来源片段（未核对原始对话）");
  expect(memory.search("茶")).not.toContain("用户原话：喜欢茶");
  expect(memory.search("无关")).toContain("[用户画像]");
  expect(memory.search("无关")).not.toContain("旧系统导入，未核对原话");
  expect(() => memory.importLegacy(plan, { revision: 1 })).toThrow("不是空库");

  const attestedMap = new Map<string, any>();
  const attestedStorage: PluginStorage = { get: (key) => structuredClone(attestedMap.get(key)), set: (key, value) => { attestedMap.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  const attestedMemory = createMemory(attestedStorage);
  attestedMemory.importLegacy(createLegacyImportPlan(file, preview.sourceHash, true), { revision: 0 });
  expect(attestedMemory.view().legacyImport?.sourceAttested).toBe(true);
  expect(attestedMemory.search("茶")).toContain("用户确认已核验的旧库来源片段（未保存消息 ID）");
  expect(attestedMemory.search("茶")).not.toContain("用户原话：喜欢茶");

  writeFileSync(file, JSON.stringify(source({
    l2: [entry({ lastAccessedAt: 123, accessCount: 0, weight: 17 })],
    l2DmaeRound: 505,
    l2DmaeStates: { m1: { activation: 52.8, userSilence: 2, modelSilence: 2, lastInjectedRound: 500, round: 505 } },
  })));
  const runtimePreview = previewLegacyMemoryFile(file);
  const runtimePlan = createLegacyImportPlan(file, runtimePreview.sourceHash, true, true);
  const runtimeMap = new Map<string, any>();
  const runtimeStorage: PluginStorage = { get: (key) => structuredClone(runtimeMap.get(key)), set: (key, value) => { runtimeMap.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  const runtimeMemory = createMemory(runtimeStorage), runtimeDmae = createDmae(runtimeStorage), runtimeLifecycle = createLifecycle(runtimeStorage);
  runtimeMemory.importLegacy(runtimePlan, { revision: 0 });
  expect(runtimeMap.has("dmae-state")).toBe(false);
  expect(runtimeMap.has("lifecycle-state")).toBe(false);
  expect(runtimeDmae.reload()).toMatchObject({ round: 505, tracked: 1 });
  expect(runtimeLifecycle.reload()).toMatchObject({ tracked: 1 });
  expect(runtimeMap.get("memory-state").legacyRuntime.lifecycle.recalls.m1).toEqual({ lastHitAt: 123, hitCount: 0, weight: 17 });
  expect(createDmae(runtimeStorage).view()).toMatchObject({ round: 505, tracked: 1 });

  const failedMap = new Map<string, any>(); let writes = 0;
  const failedStorage: PluginStorage = { get: (key) => structuredClone(failedMap.get(key)), set: (key, value) => { writes++; if (key === "memory-state") throw new Error("disk"); failedMap.set(key, structuredClone(value)); }, rootDir: () => "unused" };
  const failed = createMemory(failedStorage);
  expect(() => failed.importLegacy(plan, { revision: 0 })).toThrow("disk");
  expect(failed.view().entries).toEqual([]); expect(writes).toBe(2);
});

it.runIf(process.env.CYRENE_READONLY_IMPORT_PREVIEW_TEST === "1")("正式预检入口只读真实 memory.json", () => {
  const file = defaultLegacyMemoryPath(), digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const before = digest(readFileSync(file));
  const preview = previewLegacyMemoryFile(file);
  expect(preview.sourceHash).toBe(before);
  expect(digest(readFileSync(file))).toBe(before);
  console.log("READONLY_IMPORT_PREVIEW_SUMMARY " + JSON.stringify({ entries: preview.entries.total, validEntries: preview.entries.valid, invalidEntries: preview.entries.invalid, evidence: preview.evidence.total, validEvidence: preview.evidence.valid, invalidEvidence: preview.evidence.invalid, facets: preview.facets, profiles: preview.profiles, excluded: preview.excluded, canImport: preview.canImport, sourceWrites: 0, modelRequests: 0 }));
});
