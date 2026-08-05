// 采集用户状态向量。用 Electron powerMonitor.getSystemIdleTime() 同时覆盖键+鼠空闲。
// 上次对话时间从 chats-store listSessions 拿。
import { powerMonitor } from "electron";
import { getSession, listSessions } from "../chats/chats-store";
import type { UserStateSnapshot } from "./opener-types";

const IDLE_ACTIVE_THRESHOLD_SEC = 60;   // idle < 60s 算"活跃"
const CONTINUOUS_ACTIVITY_GRACE_SEC = 180; // 允许喝水、读屏等不超过 3 分钟的短暂空闲
const MAX_CONTINUOUS_SAMPLE_GAP_MIN = 5;
const AWAY_THRESHOLD_SEC = 1800;        // idle > 30min 算"离开"

let keyboardAccumMin = 0;               // 非空闲累计分钟（内存，重启归零可接受）
let continuousActiveMin = 0;
let lastIdleSec = 0;                    // 上次 tick 的 idle，用于检测"离开→恢复"事件
let lastSnapshotAt: number | null = null;

export function latestUserMessageAt(
  messages: ReadonlyArray<{ role: string; at: number }>,
): number | null {
  let latest: number | null = null;
  for (const message of messages) {
    if (message.role !== "user" || !Number.isFinite(message.at)) continue;
    latest = latest === null ? message.at : Math.max(latest, message.at);
  }
  return latest;
}

export function nextContinuousActiveMinutes(
  currentMinutes: number,
  idleSec: number,
  elapsedMinutes: number,
): number {
  if (idleSec >= CONTINUOUS_ACTIVITY_GRACE_SEC) return 0;
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes > MAX_CONTINUOUS_SAMPLE_GAP_MIN) return 0;
  const elapsed = Math.max(0, elapsedMinutes);
  return Math.max(0, currentMinutes) + elapsed;
}

/**
 * 采集当前状态快照。每 tick 调一次。
 * mouseResumeEvent=true 表示刚刚发生"空闲>30min 后恢复活动"（事件打断直通车用）。
 */
export function snapshot(now = Date.now()): UserStateSnapshot {
  const idleSec = powerMonitor.getSystemIdleTime();
  const localNow = new Date(now);
  const hour = localNow.getHours();
  const minute = localNow.getMinutes();
  const elapsedMinutes = lastSnapshotAt === null ? 0 : (now - lastSnapshotAt) / 60_000;
  lastSnapshotAt = now;

  const mouseResumeEvent = lastIdleSec >= AWAY_THRESHOLD_SEC && idleSec < IDLE_ACTIVE_THRESHOLD_SEC;
  lastIdleSec = idleSec;

  if (idleSec < IDLE_ACTIVE_THRESHOLD_SEC) {
    keyboardAccumMin += 1;
  } else {
    // 离开过久，活跃累计衰减
    keyboardAccumMin = Math.max(0, keyboardAccumMin - 1);
  }
  continuousActiveMin = nextContinuousActiveMinutes(continuousActiveMin, idleSec, elapsedMinutes);

  let lastChatAgoMs = Infinity;
  try {
    let latestChatAt: number | null = null;
    const sessions = listSessions().sort((a, b) => b.updatedAt - a.updatedAt);
    for (const meta of sessions) {
      if (latestChatAt !== null && meta.updatedAt <= latestChatAt) break;
      const session = getSession(meta.id);
      if (!session) continue;
      const sessionLatest = latestUserMessageAt(session.messages);
      if (sessionLatest !== null) {
        latestChatAt = latestChatAt === null ? sessionLatest : Math.max(latestChatAt, sessionLatest);
      }
    }
    if (latestChatAt !== null) {
      lastChatAgoMs = now - latestChatAt;
    }
  } catch { /* chats-store 未初始化 */ }

  return {
    hour,
    minute,
    idleSec,
    mouseResumeEvent,
    lastChatAgoMs,
    keyboardAccumMin,
    continuousActiveMin,
  };
}

/** 供测试注入的 setter（重置内部累加器）。 */
export function _resetForTest(): void {
  keyboardAccumMin = 0;
  continuousActiveMin = 0;
  lastIdleSec = 0;
  lastSnapshotAt = null;
}
