// sync/sync-service —— PC 侧同步服务：构建增量快照 + 合并对端推送。
//
// 依赖 memoryStore / history-log（二者已通过 runtime-paths 解耦 electron，可在测试中注入）。
// 合并逻辑全部委托 sync/merge 的纯函数，本模块只负责 IO 编排与游标。
//
// 幂等性：since 过滤用闭区间（>=），重复条目由 merge 的 id 并集 / 历史去重键吸收，
// 因此重复 pull/push 不会产生重复数据。
//
// 阶段 1 范围：把对端的记忆/历史合并进 PC 单一事实源。对端 push 的新 L2（无 ragId）
// 保持 pending_sync，交由 PC 既有 RAG 索引流程补做 embedding 回填（不在本模块内联）。

import { memoryStore } from "../memory/memory-store";
import {
  listHistoryStems,
  readHistoryByStem,
  writeHistoryByStem,
  type HistoryEntry,
} from "../channels/history-log";
import {
  mergeConflictLogs,
  mergeEvidence,
  mergeHistoryEntries,
  mergeL0,
  mergeL1,
  mergeL2,
  mergeReflectionLogs,
} from "./merge";
import type { HistoryBundle, SyncApplyStats, SyncSnapshot } from "./types";

/** since 判定：ISO 时间戳字符串是否 >= since(ms)。 */
function historyEntryAtOrAfter(entry: HistoryEntry, since: number): boolean {
  const t = Date.parse(entry.at);
  if (Number.isNaN(t)) return true; // 时间戳异常时保守纳入
  return t >= since;
}

/**
 * 构建同步快照。
 * @param deviceId 本端设备标识（写入快照来源，便于排障 / 阶段 3 CRDT）。
 * @param since 游标（ms）。0 或未提供 = 全量快照。闭区间过滤（>=）保证不漏。
 */
export async function buildSyncSnapshot(deviceId: string, since = 0): Promise<SyncSnapshot> {
  const store = await memoryStore.load();
  const cursor = Date.now();

  const l2 = since > 0
    ? store.l2.filter((m) => m.createdAt >= since || m.lastAccessedAt >= since)
    : store.l2;
  const evidence = since > 0
    ? (store.evidence ?? []).filter((e) => e.createdAt >= since)
    : store.evidence ?? [];
  const reflectionLogs = since > 0
    ? (store.reflectionLogs ?? []).filter((l) => l.createdAt >= since)
    : store.reflectionLogs ?? [];
  const conflictLogs = since > 0
    ? (store.conflictLogs ?? []).filter((l) => (l.resolverFinishedAt ?? l.createdAt) >= since)
    : store.conflictLogs ?? [];

  const history: HistoryBundle[] = [];
  for (const stem of listHistoryStems()) {
    const all = readHistoryByStem(stem);
    const entries = since > 0 ? all.filter((e) => historyEntryAtOrAfter(e, since)) : all;
    if (entries.length > 0) history.push({ stem, entries });
  }

  return {
    deviceId,
    cursor,
    l0: store.l0,
    l1: store.l1,
    l2,
    // embedding 不外发：向量由 PC 权威重建，剥离可显著缩小 payload。
    evidence,
    reflectionLogs,
    conflictLogs,
    history,
  };
}

/**
 * 合并对端推送的快照进 PC 单一事实源。
 * @returns 新游标（客户端下次 pull 用）+ 合并统计。
 */
export async function applySyncSnapshot(
  incoming: SyncSnapshot,
): Promise<{ cursor: number; applied: SyncApplyStats }> {
  const store = await memoryStore.load();

  const l0Result = mergeL0(store.l0, incoming.l0);
  const l1Result = mergeL1(store.l1, incoming.l1);
  const l2Result = mergeL2(store.l2, incoming.l2 ?? []);
  const evidenceResult = mergeEvidence(store.evidence ?? [], incoming.evidence ?? []);
  const reflectionResult = mergeReflectionLogs(store.reflectionLogs ?? [], incoming.reflectionLogs ?? []);
  const conflictResult = mergeConflictLogs(store.conflictLogs ?? [], incoming.conflictLogs ?? []);

  store.l0 = l0Result.merged;
  store.l1 = l1Result.merged;
  store.l2 = l2Result.merged;
  store.evidence = evidenceResult.merged;
  store.reflectionLogs = reflectionResult.merged;
  store.conflictLogs = conflictResult.merged;
  await memoryStore.save(store);

  let historyAdded = 0;
  for (const bundle of incoming.history ?? []) {
    if (!bundle.stem) continue;
    const base = readHistoryByStem(bundle.stem);
    const { merged, added } = mergeHistoryEntries(base, bundle.entries ?? []);
    if (added > 0) {
      writeHistoryByStem(bundle.stem, merged);
      historyAdded += added;
    }
  }

  const applied: SyncApplyStats = {
    l2Added: l2Result.added,
    l2Updated: l2Result.updated,
    evidenceAdded: evidenceResult.added,
    reflectionAdded: reflectionResult.added,
    conflictAdded: conflictResult.added,
    conflictUpdated: conflictResult.updated,
    historyAdded,
    l0Updated: l0Result.changed,
    l1Updated: l1Result.changed,
  };

  return { cursor: Date.now(), applied };
}
