// 屏幕监控服务 — 后台状态机，周期截图+VLM分析，低变化自动降频。
//
// 状态机：
//   IDLE → start() → PERIODIC（全速每 3 分钟截图分析）
//   PERIODIC → 低变化 → 降为低频（每 8 分钟确认一次，不停转）
//   PERIODIC → 检测到变化 → 恢复全速
//   只有 stop()（设置关闭/显式停止）才真正退出 → IDLE
//
// 低变化不停转的原因："用户持续在同一个软件里操作"也是有效上下文——
// 主动消息靠它判断是否打扰。若停转，观测会在注入侧 10 分钟过期后永久缺失。
//
// 低变化判定：两级标准（详见 decideLowChange）。
// 主标准：VLM 结构化输出的类型类目（工作/学习/日常/娱乐）等值比较——
//   类型描述"为什么在用电脑"而非"用什么软件"，浏览器里学习→娱乐能判出变化。
// 次标准：VLM 对照上次观测自判"延续/切换"——同类目下的内容切换由此捕捉。
//   （实测字符/语义相似度对 60 字摘要都不可分：切换组与连续组重叠，弃用。）
// 两级都解析失败时回落文本相似度兜底（仅覆盖旧格式自由摘要）。

import { captureAndAnalyze } from "./vlm-analyzer";
import { textSimilarity, LOW_CHANGE_SIMILARITY_THRESHOLD } from "./observation-store";
import type { VisionConfig } from "../orchestrator/vision-captioner";

const LOG_PREFIX = "[ScreenMonitor/Service]";

const PERIODIC_INTERVAL_MS = 180 * 1000; // 全速：3 分钟
const LOW_CHANGE_INTERVAL_MS = 8 * 60 * 1000; // 低频：8 分钟（观测永不过期：8 分钟 < 注入侧 10 分钟阈值）
const RETRY_INTERVAL_MS = 2 * 60 * 1000; // 失败快重试：防"低频 8 分钟 + 一次失败 + 再等 8 分钟"叠加超注入侧 10 分钟过期

/** VLM 结构化输出的类型类目（与 SCREEN_ANALYSIS_PROMPT 中的枚举一致）。
 *  描述"为什么在用电脑"而非"用什么软件"，浏览器里学习→娱乐能分属不同类目。 */
export const INTENT_CATEGORIES = [
  "工作", "学习", "日常", "娱乐",
];

/**
 * 从 VLM 摘要解析第一行的类型类目。
 * 返回类目文本（允许模型输出枚举外的类目，仍按等值比较）；无"类型："前缀返回 null。
 */
export function parseIntentCategory(summary: string): string | null {
  const firstLine = summary.split(/\r?\n/)[0]?.trim() ?? "";
  // 兼容上一版"意图："前缀的缓存观测（2 小时保留期内新旧格式共存）
  const match = firstLine.match(/^(?:类型|意图)\s*[:：]\s*(.+)$/);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  // 先剥掉括号补充说明（如"工作（写代码）"→"工作"），再按核心文本返回。
  // 不用子串归一——那会把"非工作"误判成"工作"等否定表述。
  // 剥括号后仍非标准类目的按原文返回：等值比较下同一非标准输出
  // 仍判"类目相同"，且不会错归到别的类目。
  return raw.replace(/[（(][^（）()]*[）)]/g, "").trim() || raw;
}

/**
 * 从 VLM 摘要解析第二行的连续性自判（"与上次比较：延续/切换"）。
 * VLM 在生成时已拿到上次观测做对照，这里直接读它的结论。
 * 行缺失（首次观测旧链路/格式异常）返回 null，由 decideLowChange 保守处理。
 */
export function parseContinuityVerdict(summary: string): "延续" | "切换" | null {
  const secondLine = summary.split(/\r?\n/)[1]?.trim() ?? "";
  const match = secondLine.match(/^与上次比较\s*[:：]\s*(.+)$/);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  // 精确匹配优先
  if (raw === "延续" || raw === "切换") return raw;
  // 否定表述先分流："没有切换/未切换"实际语义是延续
  if (/切换/.test(raw) && /没|未|无|不/.test(raw)) return "延续";
  if (/切换/.test(raw)) return "切换";
  // 其余可识别的表述归延续；无法识别返回 null（decideLowChange 保守判低变化）。
  // 不用"换"字做宽匹配——"更换/交换"等词与活动切换无关，误伤面大。
  if (/延续|继续|仍在|还是|照旧/.test(raw)) return "延续";
  return null;
}

/** 展示/注入用的摘要：去掉仅供判定用的"与上次比较"行，保留类型行和概括行。 */
export function toDisplaySummary(summary: string): string {
  return summary
    .split(/\r?\n/)
    .filter((line) => !/^与上次比较\s*[:：]/.test(line.trim()))
    .join("\n");
}

/**
 * 提交给 LLM 的单行格式："类型：工作，内容：用户在调试屏幕监控模块。"
 * 解析失败（旧格式自由摘要）回落压平原文，保证注入不因格式问题丢失。
 */
export function formatActivityLine(summary: string): string {
  const lines = summary.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const category = parseIntentCategory(summary);
  const rawContent = lines.find(
    (l) => !/^(?:类型|意图)\s*[:：]/.test(l) && !/^与上次比较\s*[:：]/.test(l),
  );
  // 新格式概括行带"概括："标签（与前两行结构对齐，防模型复述格式说明），剥掉前缀；
  // 旧格式无标签的概括行原样保留
  const content = rawContent?.replace(/^概括\s*[:：]\s*/, "").trim();
  if (category && content) {
    return `类型：${category}，内容：${content}`;
  }
  return lines.join(" ");
}

/**
 * 低变化判定（纯函数，便于测试）——两级标准：
 * 主标准：类型类目等值比较，类目不同即"有变化"；
 * 次标准：类目相同时读 VLM 的连续性自判，"切换"判有变化、"延续"判低变化、
 *         解析失败保守判低变化（宁可降频也不误报刷全速）；
 * 兜底：任一侧类目不可用（旧格式自由摘要）回落文本相似度。
 * lastSummary 为空（首次观测）返回 null 表示无对比对象。
 */
export function decideLowChange(
  lastSummary: string,
  lastIntent: string | null,
  summary: string,
): { lowChange: boolean; verdict: string } | null {
  if (!lastSummary) return null;
  const intent = parseIntentCategory(summary);
  if (intent && lastIntent) {
    if (intent !== lastIntent) {
      return { lowChange: false, verdict: `类型变化（${lastIntent} → ${intent}）` };
    }
    const continuity = parseContinuityVerdict(summary);
    if (continuity === "切换") {
      return { lowChange: false, verdict: `同为${intent}，VLM 判定内容已切换` };
    }
    return {
      lowChange: true,
      verdict: continuity === "延续" ? `同为${intent}，VLM 判定延续` : `同为${intent}，连续性未知（保守判低变化）`,
    };
  }
  const similarity = textSimilarity(lastSummary, summary);
  return {
    lowChange: similarity > LOW_CHANGE_SIMILARITY_THRESHOLD,
    verdict: `类目不可用，文本相似度 ${similarity.toFixed(2)}`,
  };
}

type MonitorState = "idle" | "periodic";

class ScreenMonitorService {
  private state: MonitorState = "idle";
  private timer: NodeJS.Timeout | null = null;
  private intervalMs = PERIODIC_INTERVAL_MS;
  private lastTickStartMs = 0; // 本轮 tick 开始时刻：排程用绝对时间，防 catch 改间隔后相对延迟错锚
  private lowChangeCount = 0;
  private lastSummary = "";
  private lastIntent: string | null = null;
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
    this.intervalMs = PERIODIC_INTERVAL_MS;
    this.lowChangeCount = 0;
    this.lastIntent = null;
    this.lastTickStartMs = Date.now(); // 以启动时刻为锚，首次观察在完整间隔后
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

  /**
   * 自愈拉起：开关开启且视觉配置存在、但监控没在跑时补启动。
   * 覆盖缺口：tick 里配置临时失效会 stop()（如用户换了非视觉模型），
   * 之后配置恢复只有"保存通用设置"事件会重启——用户单独改模型配置时没人拉起。
   * 由 proactive 注入路径调用：使用点自检比只依赖设置保存事件更稳。重复调用安全。
   */
  ensureRunningIfEnabled(enabled: boolean, config: VisionConfig | null): void {
    if (enabled && config && !this.isRunning()) {
      console.log(LOG_PREFIX, "监控应在运行但未运行，自愈拉起");
      this.start();
    }
  }

  private scheduleNext(): void {
    // 用绝对锚点算剩余延迟：tick 内 catch 可能刚把间隔改成快重试，
    // 若直接 setTimeout(interval) 会以"上次排程点"为锚，导致重试提前。
    const elapsed = Date.now() - this.lastTickStartMs;
    const delay = Math.max(1000, this.intervalMs - elapsed);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  private async tick(): Promise<void> {
    this.lastTickStartMs = Date.now();
    const config = this.configGetter?.();
    if (!config) {
      // 配置丢失，停止
      this.stop();
      return;
    }

    try {
      // 把上次摘要传给 VLM 做连续性对照（与 decideLowChange 的对比对象保持一致）
      const observation = await captureAndAnalyze(config, "periodic", this.lastSummary);

      // 从失败快重试恢复：先回全速，后续低变化判定会再决定是否降频
      if (this.intervalMs === RETRY_INTERVAL_MS) {
        this.intervalMs = PERIODIC_INTERVAL_MS;
      }

      // 低变化判定：类型类目主标准 + VLM 连续性次标准（纯函数，测试见同目录 test）
      const intent = parseIntentCategory(observation.summary);
      const decision = decideLowChange(this.lastSummary, this.lastIntent, observation.summary);
      if (decision) {
        if (decision.lowChange) {
          this.lowChangeCount++;
          // 稳定期降频但不停转：持续观察才能保住 proactive 的屏幕上下文
          if (this.intervalMs !== LOW_CHANGE_INTERVAL_MS) {
            this.intervalMs = LOW_CHANGE_INTERVAL_MS;
            console.log(LOG_PREFIX, "低变化：" + decision.verdict + "，降为低频间隔", LOW_CHANGE_INTERVAL_MS / 60000, "分钟");
          } else {
            console.log(LOG_PREFIX, "低变化：" + decision.verdict + "，连续", this.lowChangeCount, "次（维持低频）");
          }
        } else {
          this.lowChangeCount = 0;
          // 有变化 → 恢复全速，及时捕捉后续动态
          if (this.intervalMs !== PERIODIC_INTERVAL_MS) {
            this.intervalMs = PERIODIC_INTERVAL_MS;
            console.log(LOG_PREFIX, "有变化：" + decision.verdict + "，恢复全速间隔", PERIODIC_INTERVAL_MS / 1000, "s");
          } else {
            console.log(LOG_PREFIX, "有变化：" + decision.verdict);
          }
        }
      }
      this.lastSummary = observation.summary;
      this.lastIntent = intent;
    } catch (err) {
      console.error(LOG_PREFIX, "周期观察失败:", err instanceof Error ? err.message : String(err));
      // 失败快重试：避免低频间隔叠加失败造成 >10 分钟的观测空窗（注入侧过期阈值）
      this.intervalMs = RETRY_INTERVAL_MS;
    }

    this.scheduleNext();
  }
}

export const screenMonitorService = new ScreenMonitorService();
