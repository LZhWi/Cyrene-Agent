import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

const SETTINGS_KEY = "life-context-settings";
const CONTINUITY_KEY = "life-continuity";
const STATE_KEY = "life-state";
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

export interface LifeEvent {
  id: string;
  date: string;
  text: string;
  startAt: number;
  endAt: number;
  worldLayer: "simulated_world";
  status: "materialized" | "inferred" | "revoked";
  source: "legacy_schedule" | "runtime_schedule" | "offline_inference";
  revision: number;
}

interface LifeState {
  version: 2;
  revision: number;
  settings: LifeContextSettings;
  cursorAt: number;
  recordAfterAt: number;
  events: LifeEvent[];
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function validDate(value: unknown, annual = false): value is string {
  if (typeof value !== "string" || !(annual ? /^(\d{4}-)?\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(value)) return false;
  const [year, month, day] = (value.length === 5 ? `2000-${value}` : value).split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validateEvents(value: unknown, legacy: boolean, cursorAt: number, revision: number): LifeEvent[] {
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("生活连续性记录损坏，拒绝覆盖");
  const seen = new Set<string>();
  return value.map((event) => {
    if (!event || typeof event.id !== "string" || !event.id.trim() || seen.has(event.id)
      || !validDate(event.date) || typeof event.text !== "string" || !event.text.trim()
      || !validTimestamp(event.startAt) || !validTimestamp(event.endAt) || event.startAt >= event.endAt
      || event.worldLayer !== "simulated_world"
      || (legacy ? event.status !== "materialized"
        : !["materialized", "inferred", "revoked"].includes(event.status)
          || !["legacy_schedule", "runtime_schedule", "offline_inference"].includes(event.source)
          || !Number.isSafeInteger(event.revision) || event.revision < 0 || event.revision > revision
          || event.endAt > cursorAt
          || (event.status === "inferred" && event.source !== "offline_inference")
          || (event.status === "materialized" && event.source === "offline_inference"))) {
      throw new Error("生活连续性记录损坏，拒绝覆盖");
    }
    seen.add(event.id);
    return legacy ? { ...structuredClone(event), source: "legacy_schedule", revision: 0 } : structuredClone(event);
  });
}

function validateLegacyContinuity(value: unknown): Pick<LifeState, "cursorAt" | "events"> {
  if (!value || typeof value !== "object") throw new Error("生活连续性记录损坏，拒绝覆盖");
  const state = value as { version: unknown; cursorAt: unknown; events: unknown };
  if (state.version !== 1 || !validTimestamp(state.cursorAt)) throw new Error("生活连续性记录损坏，拒绝覆盖");
  const events = validateEvents(state.events, true, state.cursorAt, 0);
  // 旧版在系统时间倒退时会回拨游标；保留原记录并恢复已处理时间的高水位。
  const cursorAt = events.reduce((latest, event) => Math.max(latest, event.endAt), state.cursorAt);
  return { cursorAt, events };
}

function validateState(value: unknown): LifeState {
  if (!value || typeof value !== "object") throw new Error("生活状态损坏，拒绝覆盖");
  const state = value as LifeState;
  if (state.version !== 2 || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !validTimestamp(state.cursorAt) || !validTimestamp(state.recordAfterAt) || state.recordAfterAt > state.cursorAt) {
    throw new Error("生活状态损坏，拒绝覆盖");
  }
  return { ...structuredClone(state), settings: validateSettings(state.settings),
    events: validateEvents(state.events, false, state.cursorAt, state.revision) };
}

function advanceContinuity(state: LifeState, at: number, runtimeStartedAt: number): LifeState {
  if (at <= state.cursorAt) return state;
  const elapsed = at - state.cursorAt;
  if (elapsed > DETAILED_CATCH_UP_MS) {
    const event: LifeEvent = {
      id: `gap:${state.cursorAt}:${at}`, date: localDateKey(new Date(at)),
      text: "这段时间按原有生活节奏度过，未逐项保存活动",
      startAt: state.cursorAt, endAt: at, worldLayer: "simulated_world", status: "inferred",
      source: "offline_inference", revision: state.revision + 1,
    };
    return { ...state, cursorAt: at, recordAfterAt: at, events: [...state.events, event] };
  }
  const events = [...state.events], seen = new Set(events.map((event) => event.id));
  const start = new Date(state.cursorAt);
  const end = new Date(at);
  for (let day = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
    day <= end; day.setDate(day.getDate() + 1)) {
    const date = localDateKey(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12));
    for (const slot of buildDaySlots(date)) {
      const slotStartAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.startHour).getTime();
      const startAt = Math.max(state.recordAfterAt, slotStartAt);
      const endAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.endHour).getTime();
      const id = `${date}:${slot.label}`;
      if (startAt >= endAt || endAt <= state.cursorAt || endAt > at || seen.has(id)) continue;
      const inferred = startAt < runtimeStartedAt;
      const itemDuration = (endAt - slotStartAt) / slot.items.length;
      const items = slot.items.filter((_item, index) => slotStartAt + (index + 1) * itemDuration > startAt);
      events.push({ id, date, text: `${slot.label}${startAt > slotStartAt ? "（部分时段）" : ""}：${items.join("、")}`,
        startAt, endAt, worldLayer: "simulated_world", status: inferred ? "inferred" : "materialized",
        source: inferred ? "offline_inference" : "runtime_schedule", revision: state.revision + 1 });
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
  return validDate(item.date, true)
    && typeof item.label === "string" && item.label.trim().length > 0 && item.label.length <= 200;
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
  const available = events.filter((event) => event.status !== "revoked" && event.endAt <= now.getTime())
    .sort((left, right) => left.endAt - right.endAt);
  if (writtenDate && writtenDate > today) return { selected: [], requestedPast: false };
  if (writtenDate === today || /今天|今日|刚才/.test(query)) {
    const asksCompleted = /做了|做过|干了|干过|发生|完成|经历|刚才/.test(query);
    return { selected: asksCompleted ? available.filter((event) => event.date === today) : [], requestedPast: asksCompleted };
  }
  const requestedDate = writtenDate ?? (/前天/.test(query) ? relativeDate(2) : /昨天/.test(query) ? relativeDate(1) : undefined);
  if (requestedDate) return { selected: available.filter((event) => event.date === requestedDate), requestedPast: true };
  if (/现在|此刻/.test(query)) return { selected: [], requestedPast: false };
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
  if (history.selected.length) lines.push("[角色世界生活记录]",
    ...history.selected.map((event) => `${event.date} ${event.text}（${event.status === "inferred"
      ? "离线推演，不能当作确定经历" : event.source === "legacy_schedule" ? "旧版模拟记录，未区分在线与离线" : "运行期间已发生的模拟活动"}）`));
  else if (history.requestedPast) lines.push("[生活记录] 所问时段没有逐项保存的活动；不要编造具体经历。");
  lines.push(
    "使用规则：这份日程是你的背景设定，不是让你播报的内容。默认规则就一条：**用户没问你在干嘛、当前话题和你的生活也不相关时，不要提你的日程**。"
    + "例外只有两个：一：当你主动给用户发消息时，最多自然地提到一条你的日程；二：当用户主动问起你的生活与日程、或当前话题和你的生活与日程强相关时，才展开说。"
    + "提到你的日程时**不要说你在「虚拟世界」**，直接说你的行为就可以。"
    + "可以在你的虚拟世界设定内自然展开细节，但不得声称发生在现实世界或用户所在的城市；"
    + "用户问你在干嘛时，以「你现在正在做」为准；日程安排只表示计划，不能仅因时间已过就声称完成。只有运行期间已发生的模拟记录可以用完成口吻；离线推演与未区分在线离线的旧记录应保留不确定性，不补造细节。还没到的时段用「打算」的口吻。角色世界的活动不需要现实工具回执，但不要声称因此操作过现实设备或外部服务；晚上23点后到早上7点前没有日程，那是你休息或自由安排的时间。"
    + "但这只是你自己的安排，与用户**无关**——不要因为时间晚就催用户休息、替对话收尾或说「晚安」「做好梦」这类告别话，除非用户自己明确说要去休息。",
  );
  return lines.join("\n");
}

export function createLifeContext(storage: PluginStorage, now: () => number = Date.now) {
  const initializedAt = now();
  if (!validTimestamp(initializedAt)) throw new Error("生活时钟无效");
  const stored = storage.get<unknown>(STATE_KEY);
  let persisted = stored !== undefined;
  let state: LifeState;
  if (stored !== undefined) {
    state = validateState(stored);
  } else {
    const oldSettings = storage.get<unknown>(SETTINGS_KEY);
    const oldContinuity = storage.get<unknown>(CONTINUITY_KEY);
    const continuity = oldContinuity === undefined
      ? { cursorAt: Math.max(0, new Date(scheduleDate(new Date(initializedAt)).setHours(4, 0, 0, 0)).getTime()), events: [] }
      : validateLegacyContinuity(oldContinuity);
    state = { version: 2, revision: 0,
      settings: oldSettings === undefined ? { version: 1, enabled: true, importantDates: [] } : validateSettings(oldSettings),
      ...continuity, recordAfterAt: 0 };
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let runtimeStartedAt: number | undefined;

  function save(next: LifeState): void {
    if (stopped) throw new Error("生活系统已停止，拒绝写入");
    const current = storage.get<unknown>(STATE_KEY);
    if (current === undefined ? persisted : !persisted || validateState(current).revision !== state.revision) {
      throw new Error("生活状态已由其他实例更新，请重新加载");
    }
    const committed = validateState({ ...next, revision: state.revision + 1 });
    storage.set(STATE_KEY, committed);
    state = committed;
    persisted = true;
  }

  function advance(): LifeEvent[] {
    if (stopped || !state.settings.enabled) return state.events;
    const at = now();
    if (!validTimestamp(at)) throw new Error("生活时钟无效");
    const next = advanceContinuity(state, at, runtimeStartedAt ?? at);
    if (!persisted || next.events.length !== state.events.length || at - state.cursorAt >= CURSOR_CHECKPOINT_MS) save(next);
    runtimeStartedAt ??= at;
    return state.events;
  }

  const view = () => ({ ...structuredClone(state.settings), importantDatesText: formatImportantDates(state.settings.importantDates),
    continuity: structuredClone({ version: state.version, revision: state.revision, cursorAt: state.cursorAt, events: state.events }) });
  return {
    start() {
      if (timer || stopped) return;
      advance();
      timer = setInterval(() => {
        try { advance(); }
        catch (error) {
          if (timer) clearInterval(timer);
          timer = undefined;
          stopped = true;
          console.warn("[Life] 生活推进失败，已停止写入:", error instanceof Error ? error.message : String(error));
        }
      }, CURSOR_CHECKPOINT_MS);
      timer.unref?.();
    },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined; },
    view,
    configure(enabled: unknown, importantDatesText: unknown) {
      if (stopped) throw new Error("生活系统已停止，拒绝写入");
      if (typeof enabled !== "boolean") throw new Error("生活日程设置无效");
      const settings: LifeContextSettings = { version: 1, enabled, importantDates: parseImportantDates(importantDatesText) };
      const at = now();
      if (!validTimestamp(at)) throw new Error("生活时钟无效");
      const changedEnabled = enabled !== state.settings.enabled;
      if (!persisted || changedEnabled || formatImportantDates(settings.importantDates) !== formatImportantDates(state.settings.importantDates)) {
        const advanced = changedEnabled && state.settings.enabled ? advanceContinuity(state, at, runtimeStartedAt ?? at) : state;
        const cursorAt = changedEnabled ? Math.max(advanced.cursorAt, at) : advanced.cursorAt;
        save({ ...advanced, settings, cursorAt, recordAfterAt: changedEnabled ? cursorAt : advanced.recordAfterAt });
      }
      if (enabled) runtimeStartedAt ??= at;
      return view();
    },
    revokeEvent(id: string) {
      if (stopped) throw new Error("生活系统已停止，拒绝写入");
      const event = state.events.find((item) => item.id === id);
      if (!event) throw new Error("生活记录不存在");
      if (event.status !== "revoked") save({ ...state, events: state.events.map((item) => item.id === id
        ? { ...item, status: "revoked", revision: state.revision + 1 } : item) });
      return view();
    },
    build: (query = "") => state.settings.enabled ? buildContext(new Date(now()), state.settings.importantDates, advance(), query) : "",
    status: (): LifeStatus | null => {
      if (!state.settings.enabled) return null;
      advance();
      const current = new Date(now());
      return formatLifeStatus(currentActivity(buildDaySlots(localDateKey(current)), current));
    },
  };
}
