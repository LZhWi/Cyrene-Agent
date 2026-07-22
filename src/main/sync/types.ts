// sync/types —— PC ↔ iOS(RN) 局域网同步的数据契约。
//
// 阶段 1（在线同步 MVP）：快照 + 游标增量 + id 并集 / LWW 合并。
// 阶段 3 会在此基础上加 rev/tombstone 做严格双向 CRDT，届时字段向后兼容扩展。
//
// 设计原则：payload 只承载"可合并的事实数据"，不承载 embedding（向量由 PC 权威重建），
// 保持 payload 精简，避免把大数组塞进 HTTP body。

import type {
  ConflictLog,
  L0Profile,
  L1Profile,
  L2Memory,
  MemoryEvidence,
  ReflectionLog,
} from "../memory/memory-types";
import type { HistoryEntry } from "../channels/history-log";

/** 一个会话（session）的历史条目集合，key 为 history-log 的安全文件名（stem）。 */
export interface HistoryBundle {
  /** history-log 落盘用的安全文件名（PC / RN 采用同一 safeName 规则，可直接作同步键）。 */
  stem: string;
  entries: HistoryEntry[];
}

/**
 * 同步快照：一端把"自 since 以来的可合并事实"打包给对端。
 *
 * - L0/L1 始终整块携带（体积极小，按时间戳整块 LWW）。
 * - L2/evidence/logs/history 可按 since 过滤增量（缺失 = 未变更，阶段 1 无删除语义）。
 * - 不含 embedding：向量索引由 PC 作为权威持有者重建。
 */
export interface SyncSnapshot {
  /** 生成方设备标识（阶段 3 CRDT 用；阶段 1 仅记录来源便于排障）。 */
  deviceId: string;
  /** 生成时刻（ms）。对端据此推进本地游标。 */
  cursor: number;
  l0: L0Profile;
  l1: L1Profile;
  l2: L2Memory[];
  evidence: MemoryEvidence[];
  reflectionLogs: ReflectionLog[];
  conflictLogs: ConflictLog[];
  history: HistoryBundle[];
}

/** /sync/pull 的响应体。 */
export interface SyncPullResponse {
  ok: true;
  snapshot: SyncSnapshot;
}

/** /sync/push 的响应体：回传合并后 PC 的新游标 + 统计。 */
export interface SyncPushResponse {
  ok: true;
  /** 合并后 PC 侧的新游标，客户端下次 pull 用。 */
  cursor: number;
  applied: SyncApplyStats;
}

/** 合并统计，用于排障与幂等校验。 */
export interface SyncApplyStats {
  l2Added: number;
  l2Updated: number;
  evidenceAdded: number;
  reflectionAdded: number;
  conflictAdded: number;
  conflictUpdated: number;
  historyAdded: number;
  l0Updated: boolean;
  l1Updated: boolean;
}
