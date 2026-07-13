// Opener engine 共享类型。
import type { ProactiveState } from "../proactive/proactive-types";

/** 8 个场景 id（与 manifest packs 的 key 对应）。 */
export type SceneId =
  | "morning" | "late_night" | "idle_daze" | "work_break"
  | "back_from_away" | "rainy_day" | "cold_drop" | "sunny_day";

/** manifest.json 里的单条文案。 */
export interface ManifestItem {
  id: string;
  text: string;
  audio: string;            // 相对路径，如 "morning/m01.wav"
  condition?: { hourGte?: number };  // 文案级条件（如 hourGte:10 表示 10 点后才可抽中）
}

/** manifest.json 里的场景配置。 */
export interface ManifestScene {
  todayFiredFlag: string | null;  // 今日触发标志名（同名的互斥，每日重置）；null = 无每日限次
  cooldownMs: number;
  recentAvoidN: number;
  items: ManifestItem[];
}

/** manifest.json 顶层。 */
export interface Manifest {
  version: number;
  packs: Record<string, ManifestScene>;
}

/** 运行时持久化状态（opener-state.json）。 */
export interface OpenerState extends ProactiveState {
  todayFired: Record<string, boolean>;        // 今日已触发的标志
  recentItems: Record<string, string[]>;      // 各场景最近播过的 item id
  lastTriggeredScene: string | null;          // 供反馈闭环
  lastTriggeredAt: number | null;
  desireRateMultiplier: number;               // 0.5-1.5
  lastDateStr: string;                        // YYYY-MM-DD，跨天检测用
}

/** 感知层采集的状态快照（每 tick 一次）。 */
export interface UserStateSnapshot {
  hour: number;                  // 0-23
  idleSec: number;               // 系统空闲秒数（powerMonitor）
  mouseResumeEvent: boolean;     // 本 tick 是否发生"空闲>30min 后恢复活动"
  lastChatAgoMs: number;         // 距上次对话的毫秒数
  keyboardAccumMin: number;      // 非空闲累计分钟数（idleSec<60 算活跃，每 tick +1）
}

/** 天气快照。 */
export interface WeatherSnapshot {
  isRaining: boolean;
  precip: number;
  temp: number;
  tempDropFromYesterday: number;
  isSunny: boolean;
  tempComfortable: boolean;      // 18-26℃
}

/** LIVE2D_SHOW_BUBBLE payload。 */
export interface ShowBubblePayload {
  text: string;
  audioBase64?: string;
  format?: "wav" | "mp3";
  durationMs?: number;
  sceneId: string;
  itemId: string;
  sessionId?: string;
}

/** OPENER_FEEDBACK payload。 */
export interface OpenerFeedbackPayload {
  type: "clicked";   // 一期只有"点气泡"这一种反馈；"忽略"由响应窗口超时内部判定
  sceneId: string;
  itemId: string;
}
