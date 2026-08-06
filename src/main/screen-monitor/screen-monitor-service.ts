// 屏幕监控服务 — 后台状态机，周期截图+VLM分析，低变化自动停止。
//
// 状态机：
//   IDLE → start() → PERIODIC（每 periodic_interval 截图分析）
//   PERIODIC → 连续 terminate_after_low_change 次低变化 → IDLE（停止）
//
// P4 简化版：用摘要文本相似度判断低变化（不调图像 diff 库）。
// 如果两次摘要的字符重叠率高于阈值，视为"低变化"。

import { captureAndAnalyze } from "./vlm-analyzer";
import { textSimilarity } from "./observation-store";
import type { VisionConfig } from "../orchestrator/vision-captioner";

const LOG_PREFIX = "[ScreenMonitor/Service]";

const PERIODIC_INTERVAL_MS = 180 * 1000; // 3 分钟
const TERMINATE_AFTER_LOW_CHANGE = 2; // 连续 2 次低变化退出
const SIMILARITY_THRESHOLD = 0.7; // 摘要字符重叠率阈值

type MonitorState = "idle" | "periodic";

class ScreenMonitorService {
  private state: MonitorState = "idle";
  private timer: NodeJS.Timeout | null = null;
  private lowChangeCount = 0;
  private lastSummary = "";
  private configGetter: (() => VisionConfig | null) | null = null;

  /** 注入视觉模型配置获取器（index.ts 启动时调用）。 */
  setConfigGetter(getter: () => VisionConfig | null): void {
    this.configGetter = getter;
  }

  /** 启动周期观察模式。 */
  start(): void {
    if (this.timer) return; // 已在运行
    const config = this.configGetter?.();
    if (!config) {
      console.warn(LOG_PREFIX, "视觉模型未配置，不启动后台观察");
      return;
    }
    this.state = "periodic";
    this.lowChangeCount = 0;
    console.log(LOG_PREFIX, "启动周期观察，间隔", PERIODIC_INTERVAL_MS / 1000, "s");
    this.scheduleNext();
  }

  /** 停止周期观察。 */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.state !== "idle") {
      this.state = "idle";
      console.log(LOG_PREFIX, "停止周期观察");
    }
  }

  /** 是否正在运行。 */
  isRunning(): boolean {
    return this.state === "periodic";
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => this.tick(), PERIODIC_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    const config = this.configGetter?.();
    if (!config) {
      // 配置丢失，停止
      this.stop();
      return;
    }

    try {
      const observation = await captureAndAnalyze(config, "periodic");

      // P4：用摘要文本相似度判断低变化
      if (this.lastSummary) {
        const similarity = textSimilarity(this.lastSummary, observation.summary);
        if (similarity > SIMILARITY_THRESHOLD) {
          this.lowChangeCount++;
          console.log(LOG_PREFIX, "低变化（相似度", similarity.toFixed(2), "）连续", this.lowChangeCount, "次");
        } else {
          this.lowChangeCount = 0;
        }
      }
      this.lastSummary = observation.summary;

      // 连续低变化 → 停止
      if (this.lowChangeCount >= TERMINATE_AFTER_LOW_CHANGE) {
        console.log(LOG_PREFIX, "连续", TERMINATE_AFTER_LOW_CHANGE, "次低变化，退出周期模式");
        this.stop();
        return;
      }
    } catch (err) {
      console.error(LOG_PREFIX, "周期观察失败:", err instanceof Error ? err.message : String(err));
    }

    this.scheduleNext();
  }
}

export const screenMonitorService = new ScreenMonitorService();
