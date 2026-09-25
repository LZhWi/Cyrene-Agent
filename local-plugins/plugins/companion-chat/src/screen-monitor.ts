import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

const SETTINGS_KEY = "screen-monitor-settings";
export const SCREEN_PERIODIC_INTERVAL_MS = 3 * 60 * 1000;
export const SCREEN_LOW_CHANGE_INTERVAL_MS = 8 * 60 * 1000;
export const SCREEN_RETRY_INTERVAL_MS = 2 * 60 * 1000;
export const SCREEN_CONTEXT_MAX_AGE_MS = 10 * 60 * 1000;
const LOW_CHANGE_SIMILARITY = 0.45;

interface ScreenMonitorSettings { version: 1; enabled: boolean }
interface LatestObservation { at: number; text: string; noChangeSince?: number }

export interface ScreenMonitorDeps {
  storage: PluginStorage;
  observe(input?: { previousSummary?: string; signal?: AbortSignal }): Promise<{ text: string; noChange: boolean }>;
  markPeriodicUnavailable?: () => void;
  stopSignal: AbortSignal;
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

function validateSettings(value: unknown): ScreenMonitorSettings {
  if (!value || typeof value !== "object") throw new Error("屏幕观察设置损坏，拒绝覆盖");
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.enabled !== "boolean") throw new Error("屏幕观察设置损坏，拒绝覆盖");
  return structuredClone(value as ScreenMonitorSettings);
}

function textSimilarity(left: string, right: string): number {
  const a = new Set(left.normalize("NFC")), b = new Set(right.normalize("NFC"));
  let intersection = 0;
  for (const character of a) if (b.has(character)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function parseIntentCategory(summary: string): string | null {
  const firstLine = summary.split(/\r?\n/)[0]?.trim() ?? "";
  const match = firstLine.match(/^(?:类型|意图)\s*[:：]\s*(.+)$/);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  return raw.replace(/[（(][^（）()]*[）)]/g, "").trim() || raw;
}

export function parseContinuityVerdict(summary: string): "延续" | "切换" | null {
  const secondLine = summary.split(/\r?\n/)[1]?.trim() ?? "";
  const match = secondLine.match(/^与上次比较\s*[:：]\s*(.+)$/);
  if (!match) return null;
  const raw = match[1].trim();
  if (raw === "延续" || raw === "切换") return raw;
  if (/切换/.test(raw) && /没|未|无|不/.test(raw)) return "延续";
  if (/切换/.test(raw)) return "切换";
  if (/延续|继续|仍在|还是|照旧/.test(raw)) return "延续";
  return null;
}

export function formatActivityLine(summary: string): string {
  const lines = summary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const category = parseIntentCategory(summary);
  const rawContent = lines.find((line) => (
    !/^(?:类型|意图)\s*[:：]/.test(line) && !/^与上次比较\s*[:：]/.test(line)
  ));
  const content = rawContent?.replace(/^概括\s*[:：]\s*/, "").trim();
  return category && content ? `类型：${category}，内容：${content}` : lines.join(" ");
}

export function decideLowChange(
  lastSummary: string,
  lastIntent: string | null,
  summary: string,
): { lowChange: boolean; verdict: string } | null {
  if (!lastSummary) return null;
  const intent = parseIntentCategory(summary);
  if (intent && lastIntent) {
    if (intent !== lastIntent) return { lowChange: false, verdict: `类型变化（${lastIntent} → ${intent}）` };
    const continuity = parseContinuityVerdict(summary);
    if (continuity === "切换") return { lowChange: false, verdict: `同为${intent}，VLM 判定内容已切换` };
    return {
      lowChange: true,
      verdict: continuity === "延续" ? `同为${intent}，VLM 判定延续` : `同为${intent}，连续性未知（保守判低变化）`,
    };
  }
  const similarity = textSimilarity(lastSummary, summary);
  return {
    lowChange: similarity > LOW_CHANGE_SIMILARITY,
    verdict: `类目不可用，文本相似度 ${similarity.toFixed(2)}`,
  };
}

export function createScreenMonitor(deps: ScreenMonitorDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimeout ?? globalThis.clearTimeout;
  const stored = deps.storage.get<unknown>(SETTINGS_KEY);
  let settings = stored === undefined ? { version: 1 as const, enabled: false } : validateSettings(stored);
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let current: AbortController | undefined;
  let latest: LatestObservation | undefined;
  let lastIntent: string | null = null;
  let intervalMs = SCREEN_PERIODIC_INTERVAL_MS;
  let lastTickStartMs = 0;
  let stopped = false;

  function clearScheduled(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  function schedule(delay?: number): void {
    if (!settings.enabled || stopped || deps.stopSignal.aborted || timer !== undefined) return;
    const elapsed = lastTickStartMs > 0 ? now() - lastTickStartMs : 0;
    const nextDelay = delay ?? Math.max(1_000, intervalMs - elapsed);
    timer = setTimer(() => {
      timer = undefined;
      void tick();
    }, nextDelay);
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (!settings.enabled || stopped || deps.stopSignal.aborted || current) return;
    lastTickStartMs = now();
    console.log("[ScreenMonitor] 开始周期观察");
    const controller = new AbortController();
    current = controller;
    const signal = AbortSignal.any([deps.stopSignal, controller.signal]);
    try {
      const observation = await deps.observe({ previousSummary: latest?.text ?? "", signal });
      const text = observation.text.trim();
      if (signal.aborted || !settings.enabled || !text || text.startsWith("[错误]")) {
        intervalMs = text.startsWith("[错误]") ? SCREEN_RETRY_INTERVAL_MS : intervalMs;
        if (!signal.aborted && text.startsWith("[错误]")) {
          console.warn("[ScreenMonitor] 周期观察返回错误，改为", intervalMs / 60_000, "分钟后重试");
        }
        return;
      }
      const at = now();
      const decision = observation.noChange
        ? { lowChange: true, verdict: "像素级无变化（跳过 VLM 复用摘要）" }
        : decideLowChange(latest?.text ?? "", lastIntent, text);
      const lowChange = decision?.lowChange ?? false;
      latest = {
        at,
        text,
        noChangeSince: observation.noChange ? latest?.noChangeSince ?? latest?.at ?? at : undefined,
      };
      intervalMs = lowChange ? SCREEN_LOW_CHANGE_INTERVAL_MS : SCREEN_PERIODIC_INTERVAL_MS;
      lastIntent = parseIntentCategory(text);
      console.log("[ScreenMonitor] 观测完成:", JSON.stringify({
        noChange: observation.noChange,
        lowChange,
        verdict: decision?.verdict ?? "首次观测",
        summaryChars: text.length,
        durationMs: now() - lastTickStartMs,
        nextIntervalSeconds: intervalMs / 1_000,
      }));
    } catch (error) {
      if (!signal.aborted) {
        intervalMs = SCREEN_RETRY_INTERVAL_MS;
        deps.markPeriodicUnavailable?.();
        console.warn("[ScreenMonitor] 周期观察失败:", error instanceof Error ? error.message : String(error));
      }
    } finally {
      current = undefined;
      schedule();
    }
  }

  if (settings.enabled) {
    schedule();
    console.log("[ScreenMonitor] 启动周期观察，间隔", SCREEN_PERIODIC_INTERVAL_MS / 1_000, "s");
  }

  return {
    view() {
      return {
        enabled: settings.enabled,
        running: settings.enabled && !stopped && !deps.stopSignal.aborted,
        busy: Boolean(current),
        observedAt: latest?.at ?? null,
        intervalMs,
      };
    },
    configure(enabled: unknown) {
      if (typeof enabled !== "boolean" || stopped) throw new Error("屏幕观察设置无效");
      settings = { version: 1, enabled };
      deps.storage.set(SETTINGS_KEY, settings);
      if (!enabled) {
        deps.markPeriodicUnavailable?.();
        current?.abort();
        clearScheduled();
        latest = undefined;
        lastIntent = null;
        intervalMs = SCREEN_PERIODIC_INTERVAL_MS;
        lastTickStartMs = 0;
        console.log("[ScreenMonitor] 停止周期观察");
      } else {
        lastTickStartMs = now();
        schedule(SCREEN_PERIODIC_INTERVAL_MS);
        console.log("[ScreenMonitor] 启动周期观察，间隔", SCREEN_PERIODIC_INTERVAL_MS / 1_000, "s");
      }
      return this.view();
    },
    latestContext() {
      if (!settings.enabled || !latest || Math.round((now() - latest.at) / 60_000) > 10) return "";
      const ageMinutes = Math.round((now() - latest.at) / 60_000);
      const activity = `用户当前屏幕活动：${formatActivityLine(latest.text)}`;
      if (!latest.noChangeSince) return activity + (ageMinutes > 0 ? `（${ageMinutes} 分钟前观测）` : "");
      const minutes = Math.max(1, Math.round((now() - latest.noChangeSince) / 60_000));
      return `${activity}（屏幕内容在 ${minutes} 分钟内没有发生变化，推测用户可能不在使用电脑或正在休息）`;
    },
    /** 只供测试和显式刷新；自动运行仍从完整间隔后开始，避免启用即截屏。 */
    evaluate: tick,
    stop() {
      if (stopped) return;
      stopped = true;
      current?.abort();
      clearScheduled();
      latest = undefined;
      lastIntent = null;
      deps.markPeriodicUnavailable?.();
      console.log("[ScreenMonitor] 停止周期观察");
    },
  };
}
