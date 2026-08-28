// Token 用量持久化存储
//
// 存储位置：<userData>/token-usage.json
// 数据结构：按天 ISO 日期聚合，方便查询任意时间段。
//
// 写入策略：record() 立即更新内存缓存，1 秒防抖落盘（避免高频写）。
// 读取策略：首次访问时从磁盘加载到内存，后续直接读缓存。

import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "./runtime/runtime-paths";

export interface TokenUsageDay {
  input: number;
  output: number;
  hit: number;   // 缓存命中（输入中命中厂商 prompt 缓存的 token 数，仅支持上报的厂商累计）
  miss: number;  // 缓存未命中（= 同次请求的 input - hit，只在厂商上报了命中数时累计）
  requests: number;
}

interface TokenUsageStore {
  schemaVersion: 1;
  days: Record<string, TokenUsageDay>; // key = "2026-06-19"
}

const DEFAULT_STORE: TokenUsageStore = { schemaVersion: 1, days: {} };
const DEBOUNCE_MS = 1000;

function getFilePath(): string {
  return path.join(getUserDataDir(), "token-usage.json");
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let cache: TokenUsageStore | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function loadFromDisk(): TokenUsageStore {
  const filePath = getFilePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TokenUsageStore>;
      return {
        schemaVersion: 1,
        days: parsed.days && typeof parsed.days === "object" ? parsed.days : {},
      };
    }
  } catch (err) {
    console.warn("[token-usage] 加载失败，重置为空:", err);
  }
  return { ...DEFAULT_STORE, days: {} };
}

function ensureLoaded(): TokenUsageStore {
  if (!cache) cache = loadFromDisk();
  return cache;
}

function scheduleFlush(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushNow();
  }, DEBOUNCE_MS);
}

function flushNow(): void {
  if (!cache) return;
  const filePath = getFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // 原子写：先写 .tmp 再 rename
  const tmpPath = filePath + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.warn("[token-usage] 落盘失败:", err);
  }
}

// ── public API ──

/** 记录一次 API 调用的 token 用量（异步累加到当天）。
 *  cachedInput：本次输入中命中 prompt 缓存的 token 数；厂商未上报时不传，hit/miss 不动。 */
export function recordUsage(input: number, output: number, requests = 1, cachedInput?: number): void {
  const store = ensureLoaded();
  const key = todayKey();
  const day = store.days[key] ?? { input: 0, output: 0, hit: 0, miss: 0, requests: 0 };
  const inputRounded = Math.max(0, Math.round(input || 0));
  day.input += inputRounded;
  day.output += Math.max(0, Math.round(output || 0));
  day.requests += Math.max(0, requests);
  if (typeof cachedInput === "number" && Number.isFinite(cachedInput)) {
    const hit = Math.min(Math.max(0, Math.round(cachedInput)), inputRounded);
    day.hit += hit;
    day.miss += inputRounded - hit;
  }
  store.days[key] = day;
  scheduleFlush();
}

/** 查询最近 N 天的用量数据，按日期升序返回（无数据的天填 0）。 */
export function getUsage(days: number): Array<{ date: string; weekday: string; input: number; output: number; hit: number; miss: number; requests: number }> {
  const store = ensureLoaded();
  const result: Array<{ date: string; weekday: string; input: number; output: number; hit: number; miss: number; requests: number }> = [];
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const day = store.days[key];
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    result.push({
      date: `${mm}-${dd}`,
      weekday: weekdays[d.getDay()],
      input: day?.input ?? 0,
      output: day?.output ?? 0,
      hit: day?.hit ?? 0,
      miss: day?.miss ?? 0,
      requests: day?.requests ?? 0,
    });
  }
  return result;
}

/** 立即落盘（应用退出时调用）。 */
export function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  flushNow();
}
