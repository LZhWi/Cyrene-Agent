// Token 用量持久化存储
//
// 存储位置：统一 SQLite owner 的 usage 命名空间
// 数据结构：按天 ISO 日期聚合，方便查询任意时间段。
//
// 写入策略：record() 立即更新内存缓存，1 秒防抖落盘（避免高频写）。
// 读取策略：首次访问时从磁盘加载到内存，后续直接读缓存。

import { app } from "electron";
import { getServiceState, type ServiceState } from './storage/service-state';

import { applyUsageToDay, type TokenUsageDay, type TokenUsageModel } from '../shared/token-usage-counters';
export { applyUsageToDay, type TokenUsageDay, type TokenUsageModel } from '../shared/token-usage-counters';
import { randomUUID } from 'node:crypto';
interface TokenUsageStore {
  schemaVersion: 2;
  days: Record<string, TokenUsageDay>; // key = "2026-06-19"
}


const DEBOUNCE_MS = 1000;
const MAX_WAIT_MS = 5000;

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let cache: TokenUsageStore | null = null;
let sql: ServiceState | undefined;
let pendingUsage: Array<{id:string;day:string;kind:string;args:unknown[]}> = [];
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimers(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }
}

function ensureLoaded(): TokenUsageStore {
  if(!cache){sql=getServiceState(app.getPath('userData'),'usage');cache=sql.get('state');}
  return cache!;
}

function flushScheduled(): void {
  try { flushNow(); } catch (error) { console.warn('[token-usage] 定时落盘失败，保留内存等待下次请求或退出重试:', error); }
}

function scheduleFlush(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null; }
    flushScheduled();
  }, DEBOUNCE_MS);
  if (!maxWaitTimer) {
    maxWaitTimer = setTimeout(() => {
      maxWaitTimer = null;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      flushScheduled();
    }, MAX_WAIT_MS);
  }
}

function flushNow(): void {
  if (!cache) return;
  if(sql){if(pendingUsage.length){sql.call('services.usageBatch','usage',pendingUsage);pendingUsage=[];}return;}
  throw Error("SQLITE_SERVICE_UNAVAILABLE:usage");
}

// ── public API ──

/** 将一次模型调用累加到指定日期；导出供统计逻辑测试与复用。 */
/** 记录一次 API 调用的 token 用量（异步累加到当天）。 */
export function recordUsage(input: number, output: number, requests = 1, cachedInput?: number, model?: string, cacheCreation?: number): void {
  const store = ensureLoaded();
  const key = todayKey();
  const day = store.days[key] ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
  applyUsageToDay(day, input, output, requests, cachedInput, model, cacheCreation);
  if(sql)pendingUsage.push({id:randomUUID(),day:key,kind:"usage",args:[input,output,requests,cachedInput,model,cacheCreation]});
  store.days[key] = day;
  scheduleFlush();
}

/** 记录一次模型请求的发生（不依赖厂商是否返回 usage）。用于统计请求覆盖率。 */
export function recordRequest(model?: string): void {
  const store = ensureLoaded();
  const key = todayKey();
  const day = store.days[key] ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
  if(sql)pendingUsage.push({id:randomUUID(),day:key,kind:"request",args:[model]});
  day.attemptedRequests = (day.attemptedRequests ?? 0) + 1;
  const modelName = model?.trim() || "未归类";
  const byModel = day.models ?? {};
  const modelDay = byModel[modelName] ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
  modelDay.attemptedRequests = (modelDay.attemptedRequests ?? 0) + 1;
  byModel[modelName] = modelDay;
  day.models = byModel;
  store.days[key] = day;
  scheduleFlush();
}

/** 清空所有本地 Token 用量记录；传入 days 时仅清空该对象，供纯逻辑测试使用。 */
export function clearUsage(days?: Record<string, TokenUsageDay>): void {
  if (days) {
    for (const key of Object.keys(days)) delete days[key];
    return;
  }
  ensureLoaded();
  if(sql){sql.call('services.usageClear','usage');pendingUsage=[];}
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }
  cache = { schemaVersion: 2, days: {} };
  flushNow();
}

/** 查询最近 N 天的用量数据，按日期升序返回（无数据的天填 0）。 */
export function getUsage(days: number): Array<{ date: string; weekday: string; input: number; output: number; hit: number; miss: number; cacheCreation: number; requests: number; attemptedRequests: number; cacheUsageRequests: number }> {
  const store = ensureLoaded();
  const result: Array<{ date: string; weekday: string; input: number; output: number; hit: number; miss: number; cacheCreation: number; requests: number; attemptedRequests: number; cacheUsageRequests: number }> = [];
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
      cacheCreation: day?.cacheCreation ?? 0,
      requests: day?.requests ?? 0,
      attemptedRequests: day?.attemptedRequests ?? 0,
      cacheUsageRequests: day?.cacheUsageRequests ?? 0,
    });
  }
  return result;
}

export interface TokenUsageReport {
  days: ReturnType<typeof getUsage>;
  models: Array<TokenUsageModel & { model: string }>;
}

/** 查询某个时间范围的日统计和真实模型占比；历史 v1 记录归入"未归类"。 */
export function getUsageReport(days: number): TokenUsageReport {
  const daily = getUsage(days);
  const store = ensureLoaded();
  const models = new Map<string, TokenUsageModel>();
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const day = store.days[key];
    if (!day) continue;
    const entries = day.models && Object.keys(day.models).length > 0
      ? Object.entries(day.models)
      : [["未归类", day] as const];
    for (const [model, value] of entries) {
      const target = models.get(model) ?? { input: 0, output: 0, hit: 0, miss: 0, cacheCreation: 0, requests: 0 };
      target.input += value.input ?? 0;
      target.output += value.output ?? 0;
      target.hit += value.hit ?? 0;
      target.miss += value.miss ?? 0;
      target.cacheCreation += value.cacheCreation ?? 0;
      target.requests += value.requests ?? 0;
      target.attemptedRequests = (target.attemptedRequests ?? 0) + (value.attemptedRequests ?? 0);
      models.set(model, target);
    }
  }
  return {
    days: daily,
    models: [...models.entries()]
      .map(([model, value]) => ({ model, ...value }))
      // attemptedRequests > 0 也保留：端点不回 usage 的模型可见（显示 0 token），而不是从列表消失
      .filter((item) => item.input > 0 || item.output > 0 || item.requests > 0 || (item.attemptedRequests ?? 0) > 0)
      .sort((left, right) => (right.input + right.output) - (left.input + left.output)),
  };
}

/** 立即落盘（应用退出时调用）。 */
export function flush(): void {
  clearTimers();
  flushNow();
}
