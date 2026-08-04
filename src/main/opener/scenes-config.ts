// 场景配置：id / todayFiredFlag / cooldownMs / recentAvoidN
// 数值对齐 spec 第 5.1 节 manifest schema。

import type { SceneId } from "./opener-types";

export interface SceneConfig {
  id: SceneId;
  todayFiredFlag: string | null;
  cooldownMs: number;
  recentAvoidN: number;
}

export const SCENE_CONFIGS: SceneConfig[] = [
  { id: "morning",         todayFiredFlag: "daily_checkin", cooldownMs: 36000000, recentAvoidN: 0 },
  { id: "topic_followup",  todayFiredFlag: null,            cooldownMs: 21600000, recentAvoidN: 0 },
  { id: "evening_checkin", todayFiredFlag: "daily_checkin", cooldownMs: 36000000, recentAvoidN: 0 },
  { id: "late_night",      todayFiredFlag: "late_night", cooldownMs: 7200000,  recentAvoidN: 2 },
  { id: "idle_daze",       todayFiredFlag: null,         cooldownMs: 3600000,  recentAvoidN: 2 },
  { id: "work_break",      todayFiredFlag: null,         cooldownMs: 7200000,  recentAvoidN: 1 },
  { id: "back_from_away",  todayFiredFlag: null,         cooldownMs: 1800000,  recentAvoidN: 2 },
  { id: "rainy_day",       todayFiredFlag: "weather",    cooldownMs: 14400000, recentAvoidN: 2 },
  { id: "cold_drop",       todayFiredFlag: "weather",    cooldownMs: 14400000, recentAvoidN: 2 },
  { id: "sunny_day",       todayFiredFlag: "weather",    cooldownMs: 14400000, recentAvoidN: 2 },
];

/** 三档 Desire 增速（每分钟）。off 不启动 tick。 */
export const DESIRE_RATE: Record<"quiet" | "normal" | "lively", number> = {
  quiet: 1,
  normal: 2,
  lively: 4,
};

export const DESIRE_THRESHOLD = 40;        // 起步阈值
// 响应窗口：主动触发后等待接话的时长，超时记为忽略（affinity 负反馈）。
// 15 分钟：主动消息是异步消息而非弹窗，用户离开片刻后回来接话不应被误记为无视；
// 误判"忽略"的负反馈会落盘且迟到回应无法补偿，而真忽略晚记账几乎无代价。
export const RESPONSE_WINDOW_MS = 900000;  // 15 分钟响应窗口

/** affinity 边界。 */
export const AFFINITY_MIN = 0.3;
export const AFFINITY_MAX = 2.0;
export const AFFINITY_ON_CLICK = 1.2;
export const AFFINITY_ON_IGNORE = 0.85;

/** desireRateMultiplier 边界。 */
export const RATE_MULT_MIN = 0.5;
export const RATE_MULT_MAX = 1.5;
export const RATE_MULT_ON_CLICK = 1.05;
export const RATE_MULT_ON_IGNORE = 0.95;
