// get_screen_observation 工具 — 让 LLM 按需查询用户屏幕状态。
// 注册到 tool-registry，LLM 调用时截图+VLM分析，返回摘要。
// 有缓存复用（默认 30s），避免频繁截图烧 token。

import { toolRegistry, type ToolDefinition } from "../orchestrator/tool-registry";
import { observationStore } from "./observation-store";
import { captureAndAnalyze, captureAndAnalyzeFocused } from "./vlm-analyzer";
import { parseIntentCategory, decideLowChange, formatActivityLine, noChangeNote } from "./screen-monitor-service";
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
    // 去掉判定元数据，统一"类型：……，内容：……"格式返回；
    // 像素级无变化观测追加无变化时长标注（推测用户不在电脑前）
    return formatActivityLine(latest.summary) + noChangeNote(latest);
  }

  // 2. 获取视觉模型配置
  const config = visionConfigGetter?.();
  if (!config) {
    return "[错误] 未配置视觉模型，无法分析屏幕。请在设置里配置视觉模型。";
  }

  // 3. 即时截图+VLM分析
  try {
    const observation = await captureAndAnalyze(config, "tool");

    // 4. 如果只有 1 条观测，直接返回（无变化观测同样带标注）
    const recent = observationStore.getRecent(RECENT_COUNT);
    if (recent.length <= 1) {
      return formatActivityLine(observation.summary) + noChangeNote(observation);
    }

    // 5. 整合近期观测（P2：加时间跨度标注 + 变化轨迹）
    const oldest = recent[0];
    const newest = recent[recent.length - 1];
    const spanMin = Math.round((newest.timestamp - oldest.timestamp) / 60000);
    const spanText = spanMin > 0 ? "过去 " + spanMin + " 分钟" : "当前";

    const lines = recent.map((o, i) => {
      const time = new Date(o.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      // 统一"类型：……，内容：……"单行格式（判定元数据已剥离）
      let line = "[" + time + "] " + formatActivityLine(o.summary);
      // 标注变化轨迹（i>0 时和前一条比较）：与服务端同一套两级判定。
      // 标注自带参照物（"上次观测"），LLM 读单行也能明确语义，不依赖时间线惯例推断
      if (i > 0) {
        const prev = recent[i - 1].summary;
        const decision = decideLowChange(prev, parseIntentCategory(prev), o.summary);
        line += decision && !decision.lowChange ? "（较上次观测有变化）" : "（与上次观测一致）";
      }
      // 最新一条若是像素级无变化观测，追加无变化时长标注
      if (i === recent.length - 1) {
        line += noChangeNote(o);
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

/**
 * 聚焦提问分支：LLM 指定关注点，VLM 照截图回答。
 * 不复用 30s 缓存（问题不同答案必不同），答案也不写观测缓存
 * （自由格式会污染三行格式契约）——旁路语义见 vlm-analyzer。
 */
async function executeFocusedObservation(focus: string): Promise<string> {
  const config = visionConfigGetter?.();
  if (!config) {
    return "[错误] 未配置视觉模型，无法分析屏幕。请在设置里配置视觉模型。";
  }
  try {
    return await captureAndAnalyzeFocused(config, focus);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "聚焦观测失败:", msg);
    return "[错误] 屏幕观察失败：" + msg;
  }
}

/** 注册 get_screen_observation 工具到 tool-registry。 */
export function registerScreenMonitorTool(): void {
  const tool: ToolDefinition = {
    id: "get_screen_observation",
    name: "屏幕观察",
    description: "查看用户当前屏幕活动和近期变化。调用后会截图并用视觉模型分析用户正在做什么，返回屏幕活动摘要。可选传 focus 指定一个想了解的具体问题（如「用户在看什么视频」），视觉模型会照截图回答；看不到时会如实说看不出来。",
    enabled: true,
    risk: "safe",
    inputSchema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "可选。关于屏幕内容的开放式问题（如「详细描述屏幕上有什么」、「用户在学哪一章」），用「是什么样/内容是什么」式问法，避免「是不是…」的是非问句（会诱发确认式回答）。不传则返回通用活动摘要与近期变化。",
        },
      },
    },
    execute: async (args) => {
      const focus = typeof args?.focus === "string" ? args.focus.trim() : "";
      return focus ? executeFocusedObservation(focus) : executeGetScreenObservation();
    },
  };

  toolRegistry.register(tool);
  console.log(LOG_PREFIX, "已注册工具: get_screen_observation");
}
