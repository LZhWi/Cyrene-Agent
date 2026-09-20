import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ENTRY_STATUSES, type Entry } from "./entries";
import type { Evidence } from "./evidence";
import { L0_FIELDS, L1_FIELDS, type ProfileFact, type Profiles } from "./profiles";
import { normalizeStoredFacets } from "./facets";
import { deriveSummarySources } from "./summary-sources";
import { createLegacyRuntimePlan, type LegacyRuntimePlan } from "./legacy-runtime";

export interface LegacyImportPreview {
  sourceHash: string; sourceBytes: number;
  entries: { total: number; valid: number; invalid: number; duplicateIds: number; summaries: number; summaryLineageIssues: number; missingQuote: number; missingSourceAt: number; missingSourceReference: number; brokenRelations: number; statuses: Record<string, number> };
  evidence: { total: number; valid: number; invalid: number; duplicateIds: number; orphaned: number; deleted: number };
  facets: { present: number; valid: number; invalid: number; pending: number };
  profiles: { l0: number; l1: number; invalid: number; ignoredLegacyFields: number };
  excluded: { embeddings: number; facets: number; dmaeStates: number; dreams: number; reflectionLogs: number; conflictLogs: number; pendingTurns: number };
  runtime: LegacyRuntimePlan["summary"];
  canImport: boolean; warnings: string[];
}
export interface LegacyImportPlan { preview: LegacyImportPreview; entries: Entry[]; evidence: Evidence[]; profiles: Profiles; sourceAttested: boolean; runtime?: LegacyRuntimePlan }

export const defaultLegacyMemoryPath = () => path.join(homedir(), "AppData", "Roaming", "live2d-cyrene", "memory.json");
const knownStatuses = new Set<string>(ENTRY_STATUSES);
const safeStatus = (value: unknown) => knownStatuses.has(String(value)) ? String(value) : "unknown";
const arrayLength = (value: unknown) => Array.isArray(value) ? value.length : 0;
const objectValueCount = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;

function profileStats(raw: any) {
  let l0 = 0, l1 = 0, invalid = 0;
  for (const [source, fields, layer] of [[raw.l0, L0_FIELDS, "l0"], [raw.l1, L1_FIELDS, "l1"]] as const) {
    if (!source || typeof source !== "object" || Array.isArray(source)) { invalid++; continue; }
    for (const field of Object.keys(fields)) {
      const value = source[field];
      if (typeof value === "string" && value.trim()) layer === "l0" ? l0++ : l1++;
      else if (value !== undefined && typeof value !== "string") invalid++;
    }
  }
  if (l0 && !Number.isFinite(raw.l0.updatedAt)) invalid++;
  if (l1 && !Number.isFinite(raw.l1.generatedAt)) invalid++;
  const ignoredLegacyFields = typeof raw.l0?.nickname === "string" && raw.l0.nickname.trim() ? 1 : 0;
  return { l0, l1, invalid, ignoredLegacyFields };
}

/** 只返回固定字段的数量摘要；不返回、缓存或记录任何记忆正文与真实 ID。 */
export function analyzeLegacyMemory(raw: any, sourceHash = "synthetic", sourceBytes = 0): LegacyImportPreview {
  if (!raw || !Array.isArray(raw.l2) || !Array.isArray(raw.evidence)) throw new Error("源记忆格式不兼容：缺少 L2 或 evidence 数组");
  const ids = new Set<string>(), duplicateEntryIds = new Set<string>();
  let valid = 0, invalid = 0, summaries = 0, missingQuote = 0, missingSourceAt = 0, missingSourceReference = 0;
  const statuses: Record<string, number> = {};
  for (const item of raw.l2) {
    const status = safeStatus(item?.status);
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (item?.isSummary === true) summaries++;
    if (typeof item?.sourceQuote !== "string" || !item.sourceQuote.trim()) missingQuote++;
    if (!Number.isFinite(item?.sourceAt)) missingSourceAt++;
    if (typeof item?.sourceConversationId !== "string" || !item.sourceConversationId.trim()) missingSourceReference++;
    const sourceAt = item?.sourceAt ?? item?.createdAt;
    const structurallyValid = item && typeof item.id === "string" && item.id.length > 0 && typeof item.content === "string" && item.content.trim().length > 0 && item.content.length <= 100000 && Number.isFinite(sourceAt) && (item.sourceEndAt === undefined || (Number.isFinite(item.sourceEndAt) && item.sourceEndAt >= sourceAt)) && knownStatuses.has(status);
    if (structurallyValid) valid++; else invalid++;
    if (typeof item?.id === "string" && item.id) { if (ids.has(item.id)) duplicateEntryIds.add(item.id); ids.add(item.id); }
  }
  let brokenRelations = 0;
  for (const item of raw.l2) for (const key of ["supersededBy", "mergedInto"] as const) if (item?.[key] !== undefined && (!ids.has(item[key]) || item[key] === item.id)) brokenRelations++;
  let summaryLineageIssues = 0;
  if (summaries) {
    try {
      const nodes = raw.l2.map((item: any) => ({ id: item?.id, isSummary: item?.isSummary === true, ...(item?.subEntryIds === undefined ? {} : { subEntryIds: item.subEntryIds }) }));
      const leafRanges = new Map<string, { start: number; end: number }>(raw.l2.filter((item: any) => item?.isSummary !== true && Number.isFinite(item?.sourceAt ?? item?.createdAt)).map((item: any) => { const start = item.sourceAt ?? item.createdAt; return [item.id, { start, end: Number.isFinite(item.sourceEndAt) ? item.sourceEndAt : start }] as const; }));
      summaryLineageIssues = [...deriveSummarySources(nodes, leafRanges).values()].filter((result) => result.status !== "derived").length;
    } catch { summaryLineageIssues = summaries; }
  }
  const evidenceIds = new Set<string>(), duplicateEvidenceIds = new Set<string>();
  let validEvidence = 0, invalidEvidence = 0, orphaned = 0, deleted = 0;
  for (const item of raw.evidence) {
    if (item?.sourceStatus === "deleted") deleted++;
    if (typeof item?.memoryId !== "string" || !ids.has(item.memoryId)) orphaned++;
    const structurallyValid = item && typeof item.id === "string" && item.id.length > 0 && typeof item.memoryId === "string" && typeof item.quoteSnippet === "string" && Number.isFinite(item.createdAt) && ["active", "archived", "deleted"].includes(item.sourceStatus);
    if (structurallyValid) validEvidence++; else invalidEvidence++;
    if (typeof item?.id === "string" && item.id) { if (evidenceIds.has(item.id)) duplicateEvidenceIds.add(item.id); evidenceIds.add(item.id); }
  }
  let facetsPresent = 0, validFacets = 0, invalidFacets = 0, pendingFacets = 0;
  for (const item of raw.l2) if (item?.facets !== undefined) {
    facetsPresent++;
    try { const facets = normalizeStoredFacets(item.facets); validFacets++; if (facets?.pendingClassification) pendingFacets++; }
    catch { invalidFacets++; }
  }
  const profiles = profileStats(raw);
  const excluded = {
    embeddings: raw.l2.filter((item: any) => Array.isArray(item?.embedding) && item.embedding.length).length,
    facets: 0,
    dmaeStates: objectValueCount(raw.l2DmaeStates), dreams: arrayLength(raw.dreamNarratives), reflectionLogs: arrayLength(raw.reflectionLogs),
    conflictLogs: arrayLength(raw.conflictLogs), pendingTurns: arrayLength(raw.pendingTurns),
  };
  let runtime: LegacyRuntimePlan["summary"];
  try { runtime = createLegacyRuntimePlan(raw).summary; }
  catch { runtime = { lifecycleRecords: 0, dmaeStates: 0, unmappedL2: raw.l2.length, orphanedDmaeStates: 0, valid: false }; }
  const unsafe = invalid + invalidEvidence + duplicateEntryIds.size + duplicateEvidenceIds.size + brokenRelations + summaryLineageIssues + profiles.invalid + invalidFacets;
  const excludedTotal = Object.values(excluded).reduce((sum, value) => sum + value, 0);
  const warnings = [
    "预检不会导入或修改任何数据。",
    missingSourceReference ? "部分记忆没有持久化来源引用，导入后仍标为未核对。" : "",
    orphaned ? "存在无法关联到 L2 的独立证据，正式导入时必须保留为待处理项。" : "",
    profiles.ignoredLegacyFields ? "旧 nickname 不属于记忆画像字段，暂不导入；preferredName 会独立保留。" : "",
    summaryLineageIssues ? "压缩摘要存在缺失子项、未定位叶子或循环，拒绝用摘要自身时间兜底。" : "",
    excludedTotal ? "Embedding、DMAE、梦境及维护日志等尚无等价插件结构，本阶段不会导入。" : "",
    unsafe ? "检测到结构或关联问题，当前禁止导入。" : "结构检查通过仍不代表来源语义已经验证。",
  ].filter(Boolean);
  return {
    sourceHash, sourceBytes,
    entries: { total: raw.l2.length, valid, invalid, duplicateIds: duplicateEntryIds.size, summaries, summaryLineageIssues, missingQuote, missingSourceAt, missingSourceReference, brokenRelations, statuses },
    evidence: { total: raw.evidence.length, valid: validEvidence, invalid: invalidEvidence, duplicateIds: duplicateEvidenceIds.size, orphaned, deleted },
    facets: { present: facetsPresent, valid: validFacets, invalid: invalidFacets, pending: pendingFacets }, profiles, excluded, runtime, canImport: unsafe === 0, warnings,
  };
}

function readLegacyFile(file: unknown): { raw: any; hash: string; bytes: number } {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.basename(file).toLowerCase() !== "memory.json" || file.length > 2048) throw new Error("请选择名为 memory.json 的绝对路径");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024 || path.normalize(realpathSync(file)).toLowerCase() !== path.normalize(file).toLowerCase()) throw new Error("源文件类型、大小或路径校验失败");
  const buffer = readFileSync(file);
  let raw: any;
  try { raw = JSON.parse(buffer.toString("utf8")); } catch { throw new Error("源记忆 JSON 无法解析（不输出原文）"); }
  return { raw, hash: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length };
}

/** 用户显式点击预检时才读取指定 memory.json；只读一次，不跟随链接，不调用原记忆模块。 */
export function previewLegacyMemoryFile(file: unknown): LegacyImportPreview {
  const source = readLegacyFile(file);
  return analyzeLegacyMemory(source.raw, source.hash, source.bytes);
}

/** 确认导入时重新读取并核对预检哈希；映射结果只在插件进程内短暂存在。 */
export function createLegacyImportPlan(file: unknown, expectedHash: unknown, sourceAttested = false, preserveRuntime = false): LegacyImportPlan {
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("预检快照标识无效");
  if (typeof sourceAttested !== "boolean" || typeof preserveRuntime !== "boolean") throw new Error("旧库导入选项无效");
  const source = readLegacyFile(file);
  if (source.hash !== expectedHash) throw new Error("源文件自预检后已变化，请重新预检");
  const preview = analyzeLegacyMemory(source.raw, source.hash, source.bytes);
  if (!preview.canImport) throw new Error("源结构未通过导入门禁");
  const runtime = preserveRuntime ? createLegacyRuntimePlan(source.raw) : undefined;
  if (runtime && !runtime.summary.valid) throw new Error("旧运行状态未通过无损映射门禁");
  const makeFact = (content: string, sourceAt: number): ProfileFact => ({ content: content.trim(), sourceAt, quote: "", turnId: "", sessionId: "", origin: sourceAttested ? "legacy-user-attested" : "legacy-import" });
  const profiles: Profiles = { l0: {}, l1: {}, l0Locked: false };
  for (const field of Object.keys(L0_FIELDS) as Array<keyof typeof L0_FIELDS>) if (source.raw.l0[field]?.trim()) profiles.l0[field] = makeFact(source.raw.l0[field], source.raw.l0.updatedAt);
  for (const field of Object.keys(L1_FIELDS) as Array<keyof typeof L1_FIELDS>) if (source.raw.l1[field]?.trim()) profiles.l1[field] = makeFact(source.raw.l1[field], source.raw.l1.generatedAt);
  const entries: Entry[] = source.raw.l2.map((item: any) => ({
    id: item.id, content: item.content.trim(), quote: typeof item.sourceQuote === "string" ? item.sourceQuote : "", sourceAt: item.sourceAt ?? item.createdAt,
    turnId: "", sessionId: typeof item.sourceConversationId === "string" ? item.sourceConversationId : "", pinned: item.isPinned === true, status: item.status,
    provenance: sourceAttested ? "legacy-user-attested" as const : "legacy-unverified" as const,
    ...(typeof item.triggerText === "string" ? { triggerText: item.triggerText } : {}),
    ...(item.facets === undefined ? {} : { facets: normalizeStoredFacets(item.facets) }),
    ...(Number.isFinite(item.sourceEndAt) ? { sourceEndAt: item.sourceEndAt } : {}),
    ...(Number.isFinite(item.validFrom) ? { validFrom: item.validFrom } : {}), ...(Number.isFinite(item.validTo) ? { validTo: item.validTo } : {}),
    ...(typeof item.supersededBy === "string" ? { supersededBy: item.supersededBy } : {}), ...(typeof item.mergedInto === "string" ? { mergedInto: item.mergedInto } : {}),
    ...(item.isSummary === true ? { isSummary: true, subEntryIds: [...item.subEntryIds] } : {}),
  }));
  const leafRanges = new Map(entries.filter((entry) => !entry.isSummary).map((entry) => [entry.id, { start: entry.sourceAt, end: entry.sourceEndAt ?? entry.sourceAt }]));
  const summaryRanges = deriveSummarySources(entries, leafRanges);
  for (const entry of entries) if (entry.isSummary) {
    const result = summaryRanges.get(entry.id);
    if (!result || result.status !== "derived") throw new Error("压缩摘要来源谱系无法推导");
    entry.sourceAt = result.range.start; entry.sourceEndAt = result.range.end;
  }
  const evidence: Evidence[] = source.raw.evidence.map((item: any) => ({
    id: item.id, memoryId: item.memoryId, quoteSnippet: item.quoteSnippet, createdAt: item.createdAt, sourceStatus: item.sourceStatus, provenance: sourceAttested ? "legacy-user-attested" as const : "legacy-unverified" as const,
    ...(typeof item.conversationId === "string" ? { conversationId: item.conversationId } : {}), ...(Array.isArray(item.messageIds) ? { messageIds: item.messageIds } : {}),
    ...(typeof item.contextBeforeSnippet === "string" ? { contextBeforeSnippet: item.contextBeforeSnippet } : {}), ...(typeof item.contextAfterSnippet === "string" ? { contextAfterSnippet: item.contextAfterSnippet } : {}),
  }));
  return { preview, entries, evidence, profiles, sourceAttested, ...(runtime ? { runtime } : {}) };
}
