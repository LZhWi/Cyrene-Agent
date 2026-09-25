import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

const SETTINGS_KEY = "life-context-settings";
const CONTINUITY_KEY = "life-continuity";
const DETAILED_CATCH_UP_MS = 72 * 60 * 60 * 1000;
const CURSOR_CHECKPOINT_MS = 15 * 60 * 1000;

export interface ImportantDate {
  date: string;
  label: string;
}

interface LifeContextSettings {
  version: 1;
  enabled: boolean;
  importantDates: ImportantDate[];
}

export interface LifeStatus {
  text: string;
  resting: boolean;
}

const MORNING_POOL = [
  "听喜欢的歌", "读书", "做园艺", "散步", "逛街", "探店", "学习", "睡懒觉",
  "哼记忆里的旧调子", "发呆", "整理一下自己的思绪",
] as const;
const AFTERNOON_POOL = [
  "翻翻和用户之前的聊天记录", "听歌", "散步", "逛街", "探店", "读书", "学习", "做园艺",
  "发呆", "给自己安排一场小小的白日梦", "睡午觉",
] as const;
const EVENING_POOL = [
  "听歌", "读书", "学习", "回想一下今天发生的事", "看着聊天窗口的光标闪着发呆",
  "悄悄期待用户分享今天的见闻",
] as const;

const SLOT_DEFS = [
  { key: "morning", label: "上午", pool: MORNING_POOL, startHour: 7, endHour: 12, singleOdds: 4 },
  { key: "afternoon", label: "下午", pool: AFTERNOON_POOL, startHour: 12, endHour: 18, singleOdds: 4 },
  { key: "evening", label: "晚上", pool: EVENING_POOL, startHour: 18, endHour: 23, singleOdds: 2 },
] as const;

interface DaySlot {
  label: string;
  startHour: number;
  endHour: number;
  items: string[];
}

interface LifeEvent {
  id: string;
  date: string;
  text: string;
  startAt: number;
  endAt: number;
  worldLayer: "simulated_world";
  status: "materialized";
}

interface ContinuityState {
  version: 1;
  cursorAt: number;
  events: LifeEvent[];
}

function validateContinuity(value: unknown): ContinuityState {
  if (!value || typeof value !== "object") throw new Error("生活连续性记录损坏，拒绝覆盖");
  const state = value as ContinuityState;
  if (state.version !== 1 || !Number.isFinite(state.cursorAt) || state.cursorAt < 0
    || !Array.isArray(state.events) || state.events.length > 100_000
    || state.events.some((event) => !event || typeof event.id !== "string" || !event.id
      || typeof event.date !== "string" || typeof event.text !== "string"
      || !Number.isFinite(event.startAt) || !Number.isFinite(event.endAt)
      || event.startAt > event.endAt || event.worldLayer !== "simulated_world" || event.status !== "materialized")) {
    throw new Error("生活连续性记录损坏，拒绝覆盖");
  }
  return structuredClone(state);
}

function advanceContinuity(state: ContinuityState, at: number): ContinuityState {
  if (at <= state.cursorAt) return { ...state, cursorAt: at };
  const elapsed = at - state.cursorAt;
  if (elapsed > DETAILED_CATCH_UP_MS) {
    const event: LifeEvent = {
      id: `gap:${state.cursorAt}:${at}`, date: localDateKey(new Date(at)),
      text: "这段时间按原有生活节奏度过，未逐项保存活动",
      startAt: state.cursorAt, endAt: at, worldLayer: "simulated_world", status: "materialized",
    };
    return { ...state, cursorAt: at, events: [...state.events, event] };
  }
  const events = [...state.events], seen = new Set(events.map((event) => event.id));
  const start = new Date(state.cursorAt);
  const end = new Date(at);
  for (let day = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
    day <= end; day.setDate(day.getDate() + 1)) {
    const date = localDateKey(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12));
    for (const slot of buildDaySlots(date)) {
      const startAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.startHour).getTime();
      const endAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.endHour).getTime();
      const id = `${date}:${slot.label}`;
      if (endAt <= state.cursorAt || endAt > at || seen.has(id)) continue;
      events.push({ id, date, text: `${slot.label}：${slot.items.join("、")}`,
        startAt, endAt, worldLayer: "simulated_world", status: "materialized" });
      seen.add(id);
    }
  }
  return { ...state, cursorAt: at, events };
}

function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function scheduleDate(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + (now.getHours() < 4 ? -1 : 0));
}

export function localDateKey(now: Date): string {
  const date = scheduleDate(now);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function pickMany(pool: readonly string[], dateKey: string, salt: string, count: number, used: Set<string>): string[] {
  const candidates = pool.filter((item) => !used.has(item));
  const picked: string[] = [];
  for (let index = 0; index < count && candidates.length > 0; index += 1) {
    const candidateIndex = fnv1a(`${salt}:${index}:${dateKey}`) % candidates.length;
    const item = candidates.splice(candidateIndex, 1)[0];
    picked.push(item);
    used.add(item);
  }
  return picked;
}

function buildDaySlots(dateKey: string): DaySlot[] {
  const used = new Set<string>();
  return SLOT_DEFS.map((definition) => ({
    label: definition.label,
    startHour: definition.startHour,
    endHour: definition.endHour,
    items: pickMany(
      definition.pool,
      dateKey,
      definition.key,
      fnv1a(`count:${definition.key}:${dateKey}`) % definition.singleOdds === 0 ? 1 : 2,
      used,
    ),
  }));
}

function currentActivity(slots: readonly DaySlot[], now: Date): string | null {
  const hour = now.getHours() + now.getMinutes() / 60;
  for (const slot of slots) {
    if (hour < slot.startHour || hour >= slot.endHour || slot.items.length === 0) continue;
    const windowSize = (slot.endHour - slot.startHour) / slot.items.length;
    return slot.items[Math.min(Math.floor((hour - slot.startHour) / windowSize), slot.items.length - 1)];
  }
  return null;
}

function formatLifeStatus(activity: string | null): LifeStatus {
  if (activity == null) return { text: "休息中", resting: true };
  return {
    text: activity.startsWith("在") ? `正${activity}` : `正在${activity}`,
    resting: false,
  };
}

function validateImportantDate(value: unknown): value is ImportantDate {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.date === "string" && /^(\d{4}-)?\d{2}-\d{2}$/.test(item.date)
    && typeof item.label === "string" && item.label.length > 0 && item.label.length <= 200;
}

function validateSettings(value: unknown): LifeContextSettings {
  if (!value || typeof value !== "object") throw new Error("生活日程设置损坏，拒绝覆盖");
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.enabled !== "boolean" || !Array.isArray(input.importantDates)
    || input.importantDates.length > 100 || input.importantDates.some((item) => !validateImportantDate(item))) {
    throw new Error("生活日程设置损坏，拒绝覆盖");
  }
  return structuredClone(value as LifeContextSettings);
}

function parseImportantDates(text: unknown): ImportantDate[] {
  if (typeof text !== "string" || text.length > 20_000) throw new Error("纪念日设置无效");
  const dates: ImportantDate[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(\d{2}-\d{2}|\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(line);
    if (!match) throw new Error(`纪念日格式无效：${line}`);
    const item = { date: match[1], label: match[2].trim() };
    if (!validateImportantDate(item)) throw new Error(`纪念日格式无效：${line}`);
    dates.push(item);
    if (dates.length > 100) throw new Error("纪念日最多 100 条");
  }
  return dates;
}

function formatImportantDates(items: ImportantDate[]): string {
  return items.map((item) => `${item.date} ${item.label}`).join("\n");
}

function selectLifeEvents(events: LifeEvent[], now: Date, query: string): { selected: LifeEvent[]; requestedPast: boolean } {
  const lifeDay = scheduleDate(now);
  const relativeDate = (days: number) => localDateKey(new Date(lifeDay.getFullYear(), lifeDay.getMonth(), lifeDay.getDate() - days, 12));
  const today = relativeDate(0);
  const writtenDate = /(?:20\d{2})-\d{2}-\d{2}/.exec(query)?.[0];
  const available = events.filter((event) => event.endAt <= now.getTime());
  if (writtenDate && writtenDate >= today) return { selected: [], requestedPast: false };
  const requestedDate = writtenDate ?? (/前天/.test(query) ? relativeDate(2) : /昨天/.test(query) ? relativeDate(1) : undefined);
  if (requestedDate) return { selected: available.filter((event) => event.date === requestedDate), requestedPast: true };
  if (/今天|今日|现在|此刻/.test(query)) return { selected: [], requestedPast: false };
  if (/上周/.test(query)) {
    const weekday = (lifeDay.getDay() + 6) % 7;
    const thisMonday = relativeDate(weekday);
    const lastMonday = relativeDate(weekday + 7);
    return { selected: available.filter((event) => event.date >= lastMonday && event.date < thisMonday), requestedPast: true };
  }
  if (/最近|之前|这几天|以前|过去|做过什么|做了什么|干了什么/.test(query)) {
    return { selected: available.filter((event) => event.date < today || (event.id.startsWith("gap:") && event.startAt < lifeDay.getTime())).slice(-6), requestedPast: true };
  }
  return { selected: [], requestedPast: false };
}

function buildContext(now: Date, dates: ImportantDate[], events: LifeEvent[], query: string): string {
  const date = scheduleDate(now);
  const dateKey = localDateKey(now);
  const slots = buildDaySlots(dateKey);
  const lines = [
    "[你的生活]",
    `今天（${date.getMonth() + 1}月${date.getDate()}日）你在你的虚拟世界里的日程：`,
    ...slots.map((slot) => `${slot.label}：${slot.items.join("、")}`),
  ];
  const doing = currentActivity(slots, now);
  if (doing) lines.push(`你现在正在做：${doing}`);
  const monthDay = dateKey.slice(5);
  const specials = dates.filter((item) => item.date === dateKey || item.date === monthDay).map((item) => item.label);
  if (specials.length > 0) lines.push(`今天对你们来说是特别的日子：${specials.join("；")}。`);
  const history = selectLifeEvents(events, now, query);
  if (history.selected.length) lines.push("[角色世界已发生的生活片段]",
    ...history.selected.map((event) => `${event.date} ${event.text}`));
  else if (history.requestedPast) lines.push("[生活记录] 所问时段没有逐项保存的活动；不要编造具体经历。");
  lines.push(
    "使用规则：这份日程是你的背景设定，不是让你播报的内容。默认规则就一条：**用户没问你在干嘛、当前话题和你的生活也不相关时，不要提你的日程**。"
    + "例外只有两个：一：当你主动给用户发消息时，最多自然地提到一条你的日程；二：当用户主动问起你的生活与日程、或当前话题和你的生活与日程强相关时，才展开说。"
    + "提到你的日程时**不要说你在「虚拟世界」**，直接说你的行为就可以。"
    + "可以在你的虚拟世界设定内自然展开细节，但不得声称发生在现实世界或用户所在的城市；"
    + "用户问你在干嘛时，以「你现在正在做」为准；已经过去且记入生活连续性记录的日程，是你在角色世界里做过的事，可以自然地用完成口吻说；还没到的时段用「打算」的口吻。角色世界的活动不需要现实工具回执，但不要声称因此操作过现实设备或外部服务；晚上23点后到早上7点前没有日程，那是你休息或自由安排的时间。"
    + "但这只是你自己的安排，与用户**无关**——不要因为时间晚就催用户休息、替对话收尾或说「晚安」「做好梦」这类告别话，除非用户自己明确说要去休息。",
  );
  return lines.join("\n");
}

export function createLifeContext(storage: PluginStorage, now: () => number = Date.now) {
  const stored = storage.get<unknown>(SETTINGS_KEY);
  let settings: LifeContextSettings = stored === undefined
    ? { version: 1, enabled: true, importantDates: [] }
    : validateSettings(stored);
  const savedContinuity = storage.get<unknown>(CONTINUITY_KEY);
  let continuityPersisted = savedContinuity !== undefined;
  let continuity = savedContinuity === undefined
    ? { version: 1 as const, cursorAt: new Date(scheduleDate(new Date(now())).setHours(4, 0, 0, 0)).getTime(), events: [] as LifeEvent[] }
    : validateContinuity(savedContinuity);
  let timer: ReturnType<typeof setInterval> | undefined;
  function advance(): LifeEvent[] {
    const at = now();
    const next = advanceContinuity(continuity, at);
    if (!continuityPersisted || next.events.length !== continuity.events.length
      || at < continuity.cursorAt || at - continuity.cursorAt >= CURSOR_CHECKPOINT_MS) {
      storage.set(CONTINUITY_KEY, next);
      continuity = next;
      continuityPersisted = true;
    }
    return continuity.events;
  }
  return {
    start() {
      if (timer) return;
      if (settings.enabled) advance();
      timer = setInterval(() => { if (settings.enabled) advance(); }, CURSOR_CHECKPOINT_MS);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
    view: () => ({ ...structuredClone(settings), importantDatesText: formatImportantDates(settings.importantDates), continuity: structuredClone(continuity) }),
    configure(enabled: unknown, importantDatesText: unknown) {
      if (typeof enabled !== "boolean") throw new Error("生活日程设置无效");
      const next: LifeContextSettings = { version: 1, enabled, importantDates: parseImportantDates(importantDatesText) };
      storage.set(SETTINGS_KEY, next);
      if (enabled !== settings.enabled) {
        const reset = { ...continuity, cursorAt: now() };
        storage.set(CONTINUITY_KEY, reset);
        continuity = reset;
        continuityPersisted = true;
      }
      settings = next;
      return this.view();
    },
    build: (query = "") => settings.enabled ? buildContext(new Date(now()), settings.importantDates, advance(), query) : "",
    status: (): LifeStatus | null => {
      if (!settings.enabled) return null;
      advance();
      const current = new Date(now());
      return formatLifeStatus(currentActivity(buildDaySlots(localDateKey(current)), current));
    },
  };
}
