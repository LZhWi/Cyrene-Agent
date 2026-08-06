// get_screen_observation 工具 — 让 LLM 按需查询用户屏幕状态。
// 注册到 tool-registry，LLM 调用时截图+VLM分析，返回摘要。
// 有缓存复用（默认 30s），避免频繁截图烧 token。

import { toolRegistry, type ToolDefinition } from "../orchestrator/tool-registry";
import { observationStore, textSimilarity } from "./observation-store";
import { captureAndAnalyze } from "./vlm-analyzer";
import type { VisionConfig } from "../orchestrator/vision-captioner";

const LOG_PREFIX = "[ScreenMonitor/Tool]";

const CACHE_REUSE_MS = 30_000; // 30 秒内复用缓存
const RECENT_COUNT = 5; // 摘要整合最近 5 条观测

// 视觉模型配置获取器（懒加载规避循环依赖，index.ts 启动时注入）
let visionConfigGetter: (() => VisionConfig | null) | null = null;

/** index.ts 启动时调用，注入视觉模型配置获取器。 */
export function setVisionConfigGetter(getter: () => VisionConfig | null): void {
  visionConfigGetter = getter;
}

/**
 * 工具执行逻辑：
 * 1. 检查缓存是否新鲜（30s 内复用）
 * 2. 缓存过期则即时截图+VLM分析
 * 3. 整合最近几条观测返回
 */
async function executeGetScreenObservation(): Promise<string> {
  // 1. 检查缓存是否新鲜
  if (observationStore.isLatestFresh(CACHE_REUSE_MS)) {
    const latest = observationStore.getLatest()!;
    console.log(LOG_PREFIX, "复用缓存观测（" + new Date(latest.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) + "）");
    return latest.summary;
  }

  // 2. 获取视觉模型配置
  const config = visionConfigGetter?.();
  if (!config) {
    return "[错误] 未配置视觉模型，无法分析屏幕。请在设置里配置视觉模型。";
  }

  // 3. 即时截图+VLM分析
  try {
    const observation = await captureAndAnalyze(config, "tool");

    // 4. 如果只有 1 条观测，直接返回
    const recent = observationStore.getRecent(RECENT_COUNT);
    if (recent.length <= 1) {
      return observation.summary;
    }

    // 5. 整合近期观测（P2：加时间跨度标注 + 变化轨迹）
    const oldest = recent[0];
    const newest = recent[recent.length - 1];
    const spanMin = Math.round((newest.timestamp - oldest.timestamp) / 60000);
    const spanText = spanMin > 0 ? "过去 " + spanMin + " 分钟" : "当前";

    const lines = recent.map((o, i) => {
      const time = new Date(o.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      let line = "[" + time + "] " + o.summary;
      // 标注变化轨迹（i>0 时和前一条比较）
      if (i > 0) {
        const prev = recent[i - 1].summary;
        const sim = textSimilarity(prev, o.summary);
        if (sim > 0.7) {
          line += "（继续）";
        } else {
          line += "（发生变化）";
        }
      }
      return line;
    });
    return "近期屏幕活动（" + spanText + "）：\n" + lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "截图分析失败:", msg);
    return "[错误] 屏幕观察失败：" + msg;
  }
}

/** 注册 get_screen_observation 工具到 tool-registry。 */
export function registerScreenMonitorTool(): void {
  const tool: ToolDefinition = {
    id: "get_screen_observation",
    name: "屏幕观察",
    description: "查看用户当前屏幕活动和近期变化。调用后会截图并用视觉模型分析用户正在做什么，返回屏幕活动摘要。适用于需要了解用户当前屏幕状态的场景。",
    enabled: true,
    risk: "safe",
    inputSchema: {
      type: "object",
      properties: {},
    },
    execute: async () => executeGetScreenObservation(),
  };

  toolRegistry.register(tool);
  console.log(LOG_PREFIX, "已注册工具: get_screen_observation");
}
