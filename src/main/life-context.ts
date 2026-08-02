import * as fs from "node:fs";
import * as path from "node:path";

/**
 * [你的生活] 拟态日程：给昔涟一份按日期确定性生成的全天日程表，
 * 作为她"生活感"表达的唯一合法素材源（配合事实边界守则：禁止在日程之外编造现实经历）。
 *
 * 设计约束：
 * - 同一天内日程表完全一致（日期字符串做种子），一致性是核心卖点；
 * - 「你现在正在做」由时段内的确定性时间窗推进（非随机），同一分钟任何链路答案一致；
 * - 活动发生在她自己的虚拟世界（soul.md 空间设定），条目用中性时态，时态口吻交给使用规则；
 * - 纯函数无副作用，任何异常返回空串，绝不炸掉聊天主流程。
 */

export interface ImportantDate {
  /** "MM-DD"（每年重复）或 "YYYY-MM-DD"（仅当年） */
  date: string;
  label: string;
}

/** 上午活动池 */
const MORNING_POOL = [
  "听喜欢的歌",
  "读书", 
  "做园艺",
  "散步",
  "逛街",
  "探店",
  "学习",
  "睡懒觉",
  "哼记忆里的旧调子",
  "发呆（想些开心的事）",
  "整理一下自己的思绪",
] as const;

/** 下午活动池 */
const AFTERNOON_POOL = [
  "翻翻和用户之前的聊天记录",
  "听歌",
  "散步",
  "逛街",
  "探店",
  "读书",
  "学习",
  "做园艺",
  "发呆（等用户回来）",
  "给自己安排一场小小的白日梦", 
  "睡午觉",
] as const;

/** 晚上活动池 */
const EVENING_POOL = [
  "听歌",
  "读书", 
  "学习",
  "回想一下今天发生的事",
  "在心里给今天的心情打个分",
  "看着聊天窗口的光标闪着发呆",
  "悄悄期待用户分享今天的见闻",
] as const;

/** FNV-1a 32 位哈希：轻量、确定性，足够做日程种子。 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 三个大时段的边界与活动池。晚 23 点到早 7 点为日程空窗（休息时间，不输出「正在做」）。
 *  singleOdds：日期哈希有 1/singleOdds 的概率该时段只排 1 条，其余排 2 条——
 *  上午/下午 1/4（大概率 2 条，避免整个半天只有一件事显得太假），晚上 1/2（时段短，条目少一点自然）。 */
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

/**
 * 从池中确定性选取 count 条（时段内不重复；used 跨时段去重，
 * 避免出现「上午读书、下午读书」这类同日撞条目）。
 */
function pickMany(
  pool: readonly string[],
  dateKey: string,
  salt: string,
  count: number,
  used: Set<string>,
): string[] {
  const candidates = pool.filter((item) => !used.has(item));
  const picked: string[] = [];
  for (let i = 0; i < count && candidates.length > 0; i += 1) {
    const idx = fnv1a(`${salt}:${i}:${dateKey}`) % candidates.length;
    const item = candidates.splice(idx, 1)[0];
    picked.push(item);
    used.add(item);
  }
  return picked;
}

/**
 * 时间窗映射：把时段的小时数均分给该时段的条目，按当前时刻定位「正在做」。
 * 确定性推进（非随机）——同一分钟内 PC/手机/主动消息三条链路答案必然一致。
 * 日程空窗（23:00-7:00）返回 null，不输出「正在做」行。
 */
function currentActivity(slots: readonly DaySlot[], now: Date): string | null {
  const hourFloat = now.getHours() + now.getMinutes() / 60;
  for (const slot of slots) {
    if (hourFloat < slot.startHour || hourFloat >= slot.endHour || slot.items.length === 0) continue;
    const windowSize = (slot.endHour - slot.startHour) / slot.items.length;
    const idx = Math.min(
      Math.floor((hourFloat - slot.startHour) / windowSize),
      slot.items.length - 1,
    );
    return slot.items[idx];
  }
  return null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 以本地时区生成 YYYY-MM-DD 种子键。 */
export function localDateKey(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function loadImportantDates(userDataDir: string): ImportantDate[] {
  try {
    const filePath = path.join(userDataDir, "important-dates.json");
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ImportantDate => {
      if (!item || typeof item !== "object") return false;
      const record = item as { date?: unknown; label?: unknown };
      return typeof record.date === "string" && /^(\d{4}-)?\d{2}-\d{2}$/.test(record.date.trim())
        && typeof record.label === "string" && record.label.trim().length > 0;
    });
  } catch {
    // 文件损坏/权限问题：静默跳过，不影响日程主体
    return [];
  }
}

function matchImportantDates(dates: ImportantDate[], dateKey: string): string[] {
  const monthDay = dateKey.slice(5);
  return dates
    .filter((item) => {
      const value = item.date.trim();
      return value.length === 5 ? value === monthDay : value === dateKey;
    })
    .map((item) => item.label.trim());
}

/** 按日期构造全天三时段日程（跨时段去重）。buildLifeContext 与 getCurrentActivity 共用。 */
function buildDaySlots(dateKey: string): DaySlot[] {
  const used = new Set<string>();
  return SLOT_DEFS.map((def) => ({
    label: def.label,
    startHour: def.startHour,
    endHour: def.endHour,
    items: pickMany(
      def.pool,
      dateKey,
      def.key,
      fnv1a(`count:${def.key}:${dateKey}`) % def.singleOdds === 0 ? 1 : 2,
      used,
    ),
  }));
}

/**
 * 查询她此刻正在做的事（UI 状态显示用，与注入 LLM 的「你现在正在做」同源同值）。
 * 日程空窗（23:00-7:00）或异常时返回 null。
 */
export function getCurrentActivity(now: Date): string | null {
  try {
    return currentActivity(buildDaySlots(localDateKey(now)), now);
  } catch {
    return null;
  }
}

/**
 * 构造 [你的生活] 注入段。
 * @param now 当前时间（用本地日期做种子）
 * @param userDataDir Electron userData 目录（important-dates.json 所在位置）
 */
export function buildLifeContext(now: Date, userDataDir: string): string {
  try {
    const dateKey = localDateKey(now);
    // 每时段由日期哈希决定 1~2 条，全天合计 3~6 条；跨时段去重
    const slots = buildDaySlots(dateKey);

    const lines = [
      "[你的生活]",
      `今天（${now.getMonth() + 1}月${now.getDate()}日）你在你的虚拟世界里的日程：`,
      ...slots.map((slot) => `${slot.label}：${slot.items.join("、")}`),
    ];

    const doing = currentActivity(slots, now);
    if (doing) lines.push(`你现在正在做：${doing}`);

    const specials = matchImportantDates(loadImportantDates(userDataDir), dateKey);
    if (specials.length > 0) {
      lines.push(`今天对你们来说是特别的日子：${specials.join("；")}。`);
    }

    lines.push(
      "使用规则：这份日程是你的背景设定，不是让你播报的内容。默认规则就一条：**用户没问你在干嘛、当前话题和你的生活也不相关时，不要提你的日程**。" +
      "例外只有两个：一：当你主动给用户发消息时，最多自然地提到一条你的日程；二：当用户主动问起你的生活与日程、或当前话题和你的生活与日程强相关时，才展开说。" +
      "提到你的日程时**不要说你在「虚拟世界」**，直接说你的行为就可以。" +
      "可以在你的虚拟世界设定内自然展开细节，但不得声称发生在现实世界或用户所在的城市；" +
      "用户问你在干嘛时，以「你现在正在做」为准；已经过去的时段用完成的口吻说，还没到的时段用「打算」的口吻；晚上23点后到早上7点前没有日程，那是你休息或自由安排的时间。" +
      "但这只是你自己的安排，与用户**无关**——不要因为时间晚就催用户休息、替对话收尾或说「晚安」「做好梦」这类告别话，除非用户自己明确说要去休息。",
    );
    return lines.join("\n");
  } catch {
    return "";
  }
}
