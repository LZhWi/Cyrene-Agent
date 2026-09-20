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
  observe(input?: { focus?: string; signal?: AbortSignal }): Promise<string>;
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

export function createScreenMonitor(deps: ScreenMonitorDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimer = deps.clearTimeout ?? globalThis.clearTimeout;
  const stored = deps.storage.get<unknown>(SETTINGS_KEY);
  let settings = stored === undefined ? { version: 1 as const, enabled: false } : validateSettings(stored);
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let current: AbortController | undefined;
  let latest: LatestObservation | undefined;
  let intervalMs = SCREEN_PERIODIC_INTERVAL_MS;
  let stopped = false;

  function clearScheduled(): void {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  function schedule(delay = intervalMs): void {
    if (!settings.enabled || stopped || deps.stopSignal.aborted || timer !== undefined) return;
    timer = setTimer(() => {
      timer = undefined;
      void tick();
    }, delay);
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (!settings.enabled || stopped || deps.stopSignal.aborted || current) return;
    const controller = new AbortController();
    current = controller;
    const signal = AbortSignal.any([deps.stopSignal, controller.signal]);
    try {
      const text = (await deps.observe({ signal })).trim();
      if (signal.aborted || !settings.enabled || !text || text.startsWith("[错误]")) {
        intervalMs = text.startsWith("[错误]") ? SCREEN_RETRY_INTERVAL_MS : intervalMs;
        return;
      }
      const at = now();
      const lowChange = latest !== undefined && textSimilarity(latest.text, text) > LOW_CHANGE_SIMILARITY;
      latest = {
        at,
        text,
        noChangeSince: lowChange ? latest?.noChangeSince ?? latest?.at : undefined,
      };
      intervalMs = lowChange ? SCREEN_LOW_CHANGE_INTERVAL_MS : SCREEN_PERIODIC_INTERVAL_MS;
    } catch {
      if (!signal.aborted) intervalMs = SCREEN_RETRY_INTERVAL_MS;
    } finally {
      current = undefined;
      schedule();
    }
  }

  if (settings.enabled) schedule();

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
        current?.abort();
        clearScheduled();
        latest = undefined;
        intervalMs = SCREEN_PERIODIC_INTERVAL_MS;
      } else schedule();
      return this.view();
    },
    latestContext() {
      if (!settings.enabled || !latest || now() - latest.at >= SCREEN_CONTEXT_MAX_AGE_MS) return "";
      if (!latest.noChangeSince) return latest.text;
      const minutes = Math.max(1, Math.round((now() - latest.noChangeSince) / 60_000));
      return `${latest.text}\n（屏幕内容约 ${minutes} 分钟没有明显变化，用户可能持续专注，也可能暂时离开。）`;
    },
    /** 只供测试和显式刷新；自动运行仍从完整间隔后开始，避免启用即截屏。 */
    evaluate: tick,
    stop() {
      if (stopped) return;
      stopped = true;
      current?.abort();
      clearScheduled();
      latest = undefined;
    },
  };
}
