// sync/merge —— 纯函数合并逻辑（无 electron / 无 fs），PC 与 RN 共享。
//
// 阶段 1 合并策略（CRDT-lite，无 tombstone）：
//   - L2 / evidence / reflectionLogs / conflictLogs：按 id 并集；重复 id 取"更新者"。
//   - L0：按 updatedAt 整块 last-writer-wins。
//   - L1：按 generatedAt 整块替换。
//   - 历史：按 (at, role, content) 去重并集，按 at 升序，截断到上限。
//
// "更新者"判定（阶段 1 无显式 rev）：
//   - L2：lastAccessedAt → accessCount → weight，依次取大；全相等取 base（本地）。
//   - conflictLog：(resolverFinishedAt ?? createdAt) 取大；相等取 base。
//   - evidence / reflectionLog：视为不可变，重复 id 保留 base。
//
// 缺失记录不代表删除（阶段 1 无删除语义），因此可安全合并"部分增量"快照。
// 阶段 3 引入 rev/tombstone 后，本模块判定函数会被替换为 rev 比较。

import type {
  ConflictLog,
  L0Profile,
  L1Profile,
  L2Memory,
  MemoryEvidence,
  ReflectionLog,
} from "../memory/memory-types";
import type { HistoryEntry } from "../channels/history-log";

/** 历史文件最多保留的条目数（与 history-log 的 MAX_FILE_LINES 保持一致）。 */
export const HISTORY_MERGE_LIMIT = 200;
/** reflectionLogs 上限（与 memory-store 保持一致）。 */
export const REFLECTION_MERGE_LIMIT = 50;
/** conflictLogs 上限（与 memory-store 保持一致）。 */
export const CONFLICT_MERGE_LIMIT = 100;

/** L2 冲突判定：incoming 是否比 base 更"新"。 */
function l2IncomingWins(base: L2Memory, incoming: L2Memory): boolean {
  if (incoming.lastAccessedAt !== base.lastAccessedAt) {
    return incoming.lastAccessedAt > base.lastAccessedAt;
  }
  if (incoming.accessCount !== base.accessCount) {
    return incoming.accessCount > base.accessCount;
  }
  if (incoming.weight !== base.weight) {
    return incoming.weight > base.weight;
  }
  return false; // 全相等 → 保留 base
}

/** conflictLog 冲突判定：incoming 是否比 base 更"新"（推进更远）。 */
function conflictIncomingWins(base: ConflictLog, incoming: ConflictLog): boolean {
  const baseAt = base.resolverFinishedAt ?? base.createdAt;
  const incomingAt = incoming.resolverFinishedAt ?? incoming.createdAt;
  return incomingAt > baseAt;
}

interface UnionResult<T> {
  merged: T[];
  added: number;
  updated: number;
}

/** 按 id 并集，重复 id 用 pickIncoming 决定是否覆盖。保持 base 顺序，新条目追加到尾部。 */
function unionById<T extends { id: string }>(
  base: T[],
  incoming: T[],
  pickIncoming: (base: T, incoming: T) => boolean,
): UnionResult<T> {
  const index = new Map<string, number>();
  const merged: T[] = [];
  for (const item of base) {
    index.set(item.id, merged.length);
    merged.push(item);
  }
  let added = 0;
  let updated = 0;
  for (const item of incoming) {
    const pos = index.get(item.id);
    if (pos === undefined) {
      index.set(item.id, merged.length);
      merged.push(item);
      added += 1;
    } else if (pickIncoming(merged[pos], item)) {
      merged[pos] = item;
      updated += 1;
    }
  }
  return { merged, added, updated };
}

export interface L2MergeResult {
  merged: L2Memory[];
  added: number;
  updated: number;
}

export function mergeL2(base: L2Memory[], incoming: L2Memory[]): L2MergeResult {
  const { merged, added, updated } = unionById(base, incoming, l2IncomingWins);
  return { merged, added, updated };
}

export interface EvidenceMergeResult {
  merged: MemoryEvidence[];
  added: number;
}

export function mergeEvidence(base: MemoryEvidence[], incoming: MemoryEvidence[]): EvidenceMergeResult {
  // evidence 视为不可变：重复 id 保留 base。
  const { merged, added } = unionById(base, incoming, () => false);
  return { merged, added };
}

export interface ReflectionMergeResult {
  merged: ReflectionLog[];
  added: number;
}

export function mergeReflectionLogs(base: ReflectionLog[], incoming: ReflectionLog[]): ReflectionMergeResult {
  const { merged, added } = unionById(base, incoming, () => false);
  // 按 createdAt 升序保留最近 N 条
  merged.sort((a, b) => a.createdAt - b.createdAt);
  const capped = merged.length > REFLECTION_MERGE_LIMIT ? merged.slice(-REFLECTION_MERGE_LIMIT) : merged;
  return { merged: capped, added };
}

export interface ConflictMergeResult {
  merged: ConflictLog[];
  added: number;
  updated: number;
}

export function mergeConflictLogs(base: ConflictLog[], incoming: ConflictLog[]): ConflictMergeResult {
  const { merged, added, updated } = unionById(base, incoming, conflictIncomingWins);
  merged.sort((a, b) => a.createdAt - b.createdAt);
  const capped = merged.length > CONFLICT_MERGE_LIMIT ? merged.slice(-CONFLICT_MERGE_LIMIT) : merged;
  return { merged: capped, added, updated };
}

/** L0 整块 LWW：updatedAt 大者胜；相等保留 base。 */
export function mergeL0(base: L0Profile, incoming: L0Profile): { merged: L0Profile; changed: boolean } {
  if (incoming.updatedAt > base.updatedAt) {
    return { merged: incoming, changed: true };
  }
  return { merged: base, changed: false };
}

/** L1 整块替换：generatedAt 大者胜；相等保留 base。 */
export function mergeL1(base: L1Profile, incoming: L1Profile): { merged: L1Profile; changed: boolean } {
  if (incoming.generatedAt > base.generatedAt) {
    return { merged: incoming, changed: true };
  }
  return { merged: base, changed: false };
}

/** 历史条目的去重键。 */
function historyKey(e: HistoryEntry): string {
  return `${e.at}\u0000${e.role}\u0000${e.content}`;
}

export interface HistoryMergeResult {
  merged: HistoryEntry[];
  added: number;
}

/**
 * 合并单个会话的历史条目：
 * 按 (at, role, content) 去重并集 → 按 at 升序（稳定）→ 截断到 HISTORY_MERGE_LIMIT。
 */
export function mergeHistoryEntries(base: HistoryEntry[], incoming: HistoryEntry[]): HistoryMergeResult {
  const seen = new Set<string>();
  const combined: HistoryEntry[] = [];
  for (const e of base) {
    const k = historyKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    combined.push(e);
  }
  let added = 0;
  for (const e of incoming) {
    const k = historyKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    combined.push(e);
    added += 1;
  }
  // 稳定按 at 升序：at 相等时保留插入顺序（base 在前）。
  const withOrder = combined.map((entry, idx) => ({ entry, idx }));
  withOrder.sort((a, b) => {
    if (a.entry.at < b.entry.at) return -1;
    if (a.entry.at > b.entry.at) return 1;
    return a.idx - b.idx;
  });
  let sorted = withOrder.map((x) => x.entry);
  if (sorted.length > HISTORY_MERGE_LIMIT) {
    sorted = sorted.slice(-HISTORY_MERGE_LIMIT);
  }
  return { merged: sorted, added };
}
