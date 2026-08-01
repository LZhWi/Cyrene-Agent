/**
 * Memory Structured Output Schemas — 三个 Memory 操作的 parseSchema / validateBusiness。
 *
 * 配合 runStructuredOutput<T>() 使用：
 *   parseSchema: 从 LLM 输出中提取并校验结构化对象
 *   validateBusiness: 业务级别校验（当前均为 pass-through）
 */

import type { BusinessValidationResult } from "../orchestrator/structured-output/runner";
import type { StructuredErrorDisposition } from "../orchestrator/structured-output/errors";
import type { MemoryCandidate, MemoryConflictResolution } from "./memory-types";

// ── 公共工具 ──

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, i) => {
    if (typeof item !== "string") throw new Error(`${label}[${i}] must be a string`);
    return item;
  });
}

// ── Judge Schema ──

const VALID_LAYERS = new Set(["L0", "L1", "L2"]);
const VALID_IMPORTANCE = new Set(["low", "medium", "high"]);
const VALID_STABILITY = new Set(["one_off", "situational", "stable"]);
const VALID_CERTAINTY = new Set(["explicit", "inferred", "uncertain"]);
const VALID_ATTRIBUTION = new Set(["user_explicit", "assistant_inferred", "mixed"]);

function parseMemoryCandidate(value: unknown): MemoryCandidate {
  const obj = requiredObject(value, "candidate");
  const layer = requiredString(obj.layer, "layer");
  if (!VALID_LAYERS.has(layer)) throw new Error(`layer must be L0/L1/L2, got "${layer}"`);
  const result: MemoryCandidate = {
    layer: layer as MemoryCandidate["layer"],
    content: requiredString(obj.content, "content"),
    confidence: requiredNumber(obj.confidence, "confidence"),
    triggerText: requiredString(obj.triggerText, "triggerText"),
  };
  if (typeof obj.field === "string" && obj.field.trim()) result.field = obj.field.trim();
  if (typeof obj.summary === "string" && obj.summary.trim()) result.summary = obj.summary.trim();
  if (VALID_IMPORTANCE.has(obj.importance as string)) result.importance = obj.importance as MemoryCandidate["importance"];
  if (VALID_STABILITY.has(obj.stability as string)) result.stability = obj.stability as MemoryCandidate["stability"];
  if (VALID_CERTAINTY.has(obj.certainty as string)) result.certainty = obj.certainty as MemoryCandidate["certainty"];
  if (VALID_ATTRIBUTION.has(obj.attribution as string)) result.attribution = obj.attribution as MemoryCandidate["attribution"];
  if (Array.isArray(obj.evidenceQuotes)) result.evidenceQuotes = stringArray(obj.evidenceQuotes, "evidenceQuotes");
  if (typeof obj.contextSummary === "string") result.contextSummary = obj.contextSummary;
  if (typeof obj.shouldWrite === "boolean") result.shouldWrite = obj.shouldWrite;
  if (typeof obj.reason === "string") result.reason = obj.reason;
  if (Array.isArray(obj.forbiddenOverclaims)) result.forbiddenOverclaims = stringArray(obj.forbiddenOverclaims, "forbiddenOverclaims");
  return result;
}

/**
 * 从 LLM 输出中提取 MemoryCandidate 数组。
 * runStructuredOutput 的 parseSchema 回调。
 */
export function parseMemoryJudgeResult(value: unknown): MemoryCandidate[] {
  // runStructuredOutput 传入的是已经从 JSON 中提取的对象
  // Judge 输出格式：数组 或 { candidates: [...] }
  let arr: unknown[];
  if (Array.isArray(value)) {
    arr = value;
  } else if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).candidates)) {
    arr = (value as Record<string, unknown>).candidates as unknown[];
  } else {
    throw new Error("Memory judge result must be an array or { candidates: [...] }");
  }
  return arr.map((item, i) => {
    try {
      return parseMemoryCandidate(item);
    } catch (err) {
      throw new Error(`candidate[${i}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function validateMemoryJudgeBusiness(
  candidates: MemoryCandidate[],
): BusinessValidationResult<MemoryCandidate[]> {
  // 空数组是合法结果：表示最近对话没有值得写入的记忆。
  return { status: "accepted", value: candidates };
}

// ── Compress Schema ──

export interface MemoryCompressionGroup {
  ids: string[];
  summary: string;
}

function parseCompressionGroup(value: unknown): MemoryCompressionGroup {
  const obj = requiredObject(value, "group");
  return {
    ids: stringArray(obj.ids, "ids"),
    summary: requiredString(obj.summary, "summary"),
  };
}

/**
 * 从 LLM 输出中提取 MemoryCompressionGroup 数组。
 */
export function parseMemoryCompressResult(value: unknown): MemoryCompressionGroup[] {
  let arr: unknown[];
  if (Array.isArray(value)) {
    arr = value;
  } else if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).groups)) {
    arr = (value as Record<string, unknown>).groups as unknown[];
  } else {
    throw new Error("Memory compress result must be an array or { groups: [...] }");
  }
  return arr.map((item, i) => {
    try {
      return parseCompressionGroup(item);
    } catch (err) {
      throw new Error(`group[${i}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function validateMemoryCompressBusiness(
  groups: MemoryCompressionGroup[],
): BusinessValidationResult<MemoryCompressionGroup[]> {
  if (groups.length === 0) {
    return { status: "rejected", error: { layer: "schema", code: "EMPTY_GROUPS", disposition: "fail_closed" } };
  }
  return { status: "accepted", value: groups };
}

// ── Resolve Schema ──

const VALID_RESOLUTION_TYPES = new Set([
  "unrelated", "context_difference", "preference_evolution", "direct_conflict", "uncertain",
]);

const VALID_MEMORY_STATUS = new Set(["active", "aging", "archived", "superseded", "merged"]);

function parseResolutionActions(value: unknown): MemoryConflictResolution["actions"] {
  const obj = requiredObject(value, "actions");
  const result: MemoryConflictResolution["actions"] = {
    createResolvedMemory: obj.createResolvedMemory === true,
  };
  if (VALID_MEMORY_STATUS.has(obj.oldMemoryStatus as string)) {
    result.oldMemoryStatus = obj.oldMemoryStatus as MemoryConflictResolution["actions"]["oldMemoryStatus"];
  }
  if (VALID_MEMORY_STATUS.has(obj.newMemoryStatus as string)) {
    result.newMemoryStatus = obj.newMemoryStatus as MemoryConflictResolution["actions"]["newMemoryStatus"];
  }
  if (obj.shouldUpdateCoreMemory === true) result.shouldUpdateCoreMemory = true;
  if (obj.shouldAskUser === true) result.shouldAskUser = true;
  if (obj.clarificationNeeded === true) result.clarificationNeeded = true;
  return result;
}

/**
 * 从 LLM 输出中提取 MemoryConflictResolution。
 */
export function parseMemoryResolveResult(value: unknown): MemoryConflictResolution {
  const obj = requiredObject(value, "resolution");
  const resolutionType = requiredString(obj.resolutionType, "resolutionType");
  if (!VALID_RESOLUTION_TYPES.has(resolutionType)) {
    throw new Error(`resolutionType must be one of ${[...VALID_RESOLUTION_TYPES].join(", ")}, got "${resolutionType}"`);
  }
  const reason = requiredString(obj.reason, "reason");
  const confidence = requiredNumber(obj.confidence, "confidence");
  const result: MemoryConflictResolution = {
    resolutionType: resolutionType as MemoryConflictResolution["resolutionType"],
    reason,
    confidence,
    actions: parseResolutionActions(obj.actions),
  };
  if (typeof obj.resolvedSummary === "string" && obj.resolvedSummary.trim()) {
    result.resolvedSummary = obj.resolvedSummary.trim();
  }
  if (typeof obj.currentSummary === "string" && obj.currentSummary.trim()) {
    result.currentSummary = obj.currentSummary.trim();
  }
  if (typeof obj.historicalSummary === "string" && obj.historicalSummary.trim()) {
    result.historicalSummary = obj.historicalSummary.trim();
  }
  return result;
}

export function validateMemoryResolveBusiness(
  resolution: MemoryConflictResolution,
): BusinessValidationResult<MemoryConflictResolution> {
  if (!resolution.reason.trim()) {
    return { status: "rejected", error: { layer: "schema", code: "EMPTY_REASON", disposition: "fail_closed" } };
  }
  return { status: "accepted", value: resolution };
}

// ── Reflection Schema ──

export interface MemoryReflectionItem {
  layer: "L0" | "L1";
  field?: string;
  content: string;
  confidence: number;
}

function parseReflectionItem(value: unknown): MemoryReflectionItem {
  const obj = requiredObject(value, "reflection item");
  const layer = requiredString(obj.layer, "layer");
  if (layer !== "L0" && layer !== "L1") throw new Error(`layer must be L0/L1, got "${layer}"`);
  return {
    layer,
    field: optionalString(obj.field),
    content: requiredString(obj.content, "content"),
    confidence: requiredNumber(obj.confidence, "confidence"),
  };
}

/**
 * 从 LLM 输出中提取 MemoryReflectionItem 数组。
 */
export function parseMemoryReflectionResult(value: unknown): MemoryReflectionItem[] {
  let arr: unknown[];
  if (Array.isArray(value)) {
    arr = value;
  } else if (value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).updates)) {
    arr = (value as Record<string, unknown>).updates as unknown[];
  } else {
    throw new Error("Memory reflection result must be an array or { updates: [...] }");
  }
  return arr.map((item, i) => {
    try {
      return parseReflectionItem(item);
    } catch (err) {
      throw new Error(`item[${i}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function validateMemoryReflectionBusiness(
  items: MemoryReflectionItem[],
): BusinessValidationResult<MemoryReflectionItem[]> {
  // 空数组是合法的 —— 表示没有需要更新的内容
  return { status: "accepted", value: items };
}
