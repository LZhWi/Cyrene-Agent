import type { LifeEvent } from "./life-context";

export interface LifeEventRef { id: string; revision: number }
export type LifeGoalStatus = "active" | "paused" | "completed" | "cancelled";
export interface LifeGoal {
  id: string; title: string; activity: string; dueDate: string | null; remind: boolean;
  status: LifeGoalStatus; source: "user"; revision: number;
  createdAt: number; updatedAt: number; activeSince: number; eventRefs: LifeEventRef[];
}
export interface LifeDiary {
  id: string; date: string; summary: string; eventRefs: LifeEventRef[]; revision: number;
  status: "active" | "revoked"; createdAt: number; updatedAt: number;
}
export interface LifeJournal { goals: LifeGoal[]; diaries: LifeDiary[] }

const statuses: LifeGoalStatus[] = ["active", "paused", "completed", "cancelled"];
const timestamp = (value: unknown, max: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
function dateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
const sameRefs = (left: LifeEventRef[], right: LifeEventRef[]) => JSON.stringify(left) === JSON.stringify(right);
const refsOf = (events: LifeEvent[]) => events.map(({ id, revision }) => ({ id, revision }));
const goalEvidence = (event: LifeEvent, activity: string) => event.status === "materialized"
  && event.source === "runtime_schedule" && event.text.includes(activity);
const diarySummary = (events: LifeEvent[]) => events.map((event) => `${event.source === "legacy_schedule" ? "旧版模拟记录（来源未细分）"
  : event.status === "inferred" ? "离线推演" : "模拟活动"}：${event.text}`).join("\n").slice(0, 8_000);

export function validateJournal(value: unknown, events: LifeEvent[], maxAt: number, revision: number): LifeJournal {
  if (value === undefined) return { goals: [], diaries: [] };
  const journal = value as LifeJournal;
  const bad = () => new Error("生活日记或目标损坏，拒绝覆盖");
  if (!journal || !Array.isArray(journal.goals) || journal.goals.length > 100
    || !Array.isArray(journal.diaries) || journal.diaries.length > 10_000) throw bad();
  const byId = new Map(events.map((event) => [event.id, event]));
  function validRefs(refs: LifeEventRef[], allowRevoked = false): boolean {
    return Array.isArray(refs) && refs.length <= 100_000 && new Set(refs.map((ref) => ref?.id)).size === refs.length
      && refs.every((ref) => ref && typeof ref.id === "string" && byId.has(ref.id)
        && ref.revision === byId.get(ref.id)!.revision && (allowRevoked || byId.get(ref.id)!.status !== "revoked"));
  }
  if (new Set(journal.goals.map((goal) => goal?.id)).size !== journal.goals.length
    || journal.goals.filter((goal) => goal?.status === "active").length > 3) throw bad();
  for (const goal of journal.goals) {
    if (!goal || typeof goal.id !== "string" || !goal.id || typeof goal.title !== "string" || !goal.title.trim() || goal.title.length > 160
      || typeof goal.activity !== "string" || !goal.activity.trim() || goal.activity.length > 200
      || (goal.dueDate !== null && !dateKey(goal.dueDate)) || typeof goal.remind !== "boolean"
      || !statuses.includes(goal.status) || goal.source !== "user" || !timestamp(goal.revision, revision)
      || !timestamp(goal.createdAt, maxAt) || !timestamp(goal.updatedAt, maxAt) || goal.updatedAt < goal.createdAt
      || !timestamp(goal.activeSince, maxAt) || goal.activeSince < goal.createdAt || !validRefs(goal.eventRefs)
      || goal.eventRefs.some((ref) => !goalEvidence(byId.get(ref.id)!, goal.activity)
        || byId.get(ref.id)!.startAt < goal.createdAt || byId.get(ref.id)!.endAt > goal.updatedAt)) throw bad();
  }
  if (new Set(journal.diaries.map((diary) => diary?.date)).size !== journal.diaries.length) throw bad();
  for (const diary of journal.diaries) {
    if (!diary || !dateKey(diary.date) || diary.id !== `diary:${diary.date}` || typeof diary.summary !== "string" || diary.summary.length > 8_000
      || !["active", "revoked"].includes(diary.status) || !timestamp(diary.revision, revision)
      || !timestamp(diary.createdAt, maxAt) || !timestamp(diary.updatedAt, maxAt) || diary.updatedAt < diary.createdAt
      || !validRefs(diary.eventRefs) || (diary.status === "active") !== (diary.eventRefs.length > 0)
      || diary.eventRefs.some((ref) => byId.get(ref.id)!.date !== diary.date || byId.get(ref.id)!.endAt > diary.updatedAt)
      || diary.summary !== diarySummary(diary.eventRefs.map((ref) => byId.get(ref.id)!))) throw bad();
  }
  return structuredClone(journal);
}

export function saveLifeGoal(goals: LifeGoal[], input: unknown, at: number, revision: number, activities: string[]): LifeGoal[] {
  if (!input || typeof input !== "object") throw new Error("生活目标无效");
  const data = input as Record<string, unknown>;
  if (data.id !== undefined && (typeof data.id !== "string" || !data.id)) throw new Error("生活目标 ID 无效");
  const previous = data.id === undefined ? undefined : goals.find((goal) => goal.id === data.id);
  if (data.id !== undefined && !previous) throw new Error("生活目标不存在");
  const dueDate = data.dueDate === "" || data.dueDate == null ? null : data.dueDate;
  const status = data.status ?? previous?.status ?? "active";
  const remind = data.remind ?? previous?.remind ?? true;
  if (typeof data.title !== "string" || !data.title.trim() || data.title.trim().length > 160
    || typeof data.activity !== "string" || !activities.includes(data.activity)
    || (dueDate !== null && !dateKey(dueDate)) || !statuses.includes(status as LifeGoalStatus) || typeof remind !== "boolean") throw new Error("生活目标字段无效");
  if (!previous && goals.length >= 100) throw new Error("生活目标记录已达上限");
  const changedContent = previous && (previous.title !== data.title.trim() || previous.activity !== data.activity);
  const goal: LifeGoal = { id: previous?.id ?? `goal:${revision}`, title: data.title.trim(), activity: data.activity,
    dueDate, remind, status: status as LifeGoalStatus, source: "user", revision,
    createdAt: previous?.createdAt ?? at, updatedAt: at,
    activeSince: !previous || changedContent || previous.status !== "active" ? at : previous.activeSince,
    eventRefs: changedContent ? [] : structuredClone(previous?.eventRefs ?? []) };
  const next = previous ? goals.map((item) => item.id === goal.id ? goal : structuredClone(item)) : [...structuredClone(goals), goal];
  if (next.filter((item) => item.status === "active").length > 3) throw new Error("最多同时保留 3 个活跃生活目标");
  return next;
}

export function setLifeGoalStatus(goals: LifeGoal[], id: string, status: LifeGoalStatus, at: number, revision: number): LifeGoal[] {
  const previous = goals.find((goal) => goal.id === id);
  if (!previous || !statuses.includes(status)) throw new Error("生活目标或状态无效");
  return saveLifeGoal(goals, { ...previous, status }, at, revision, [previous.activity]);
}

function diaryFor(previous: LifeDiary | undefined, date: string, events: LifeEvent[], at: number, revision: number): LifeDiary | undefined {
  const selected = events.filter((event) => event.date === date && event.status !== "revoked" && event.endAt <= at)
    .sort((a, b) => a.endAt - b.endAt).slice(-24);
  if (!selected.length && !previous) return undefined;
  const eventRefs = refsOf(selected);
  const summary = diarySummary(selected);
  if (previous && sameRefs(previous.eventRefs, eventRefs) && previous.summary === summary) return previous;
  return { id: `diary:${date}`, date, summary, eventRefs, revision, status: selected.length ? "active" : "revoked",
    createdAt: previous?.createdAt ?? at, updatedAt: at };
}

export function rebuildLifeDiary(journal: LifeJournal, date: string, events: LifeEvent[], at: number, revision: number): LifeJournal {
  if (!dateKey(date)) throw new Error("日记日期无效");
  const previous = journal.diaries.find((diary) => diary.date === date);
  const diary = diaryFor(previous, date, events, at, revision);
  if (!diary) throw new Error("所选日期没有可引用的生活记录");
  if (diary === previous) return structuredClone(journal);
  if (!previous && journal.diaries.length >= 10_000) throw new Error("生活日记已达上限");
  return { goals: structuredClone(journal.goals), diaries: previous
    ? journal.diaries.map((item) => item.date === date ? diary : structuredClone(item)) : [...structuredClone(journal.diaries), diary] };
}

/** 只派生角色生活资料，不调用模型、不创建用户事实、不自动完成目标。 */
export function reconcileLifeJournal(journal: LifeJournal, events: LifeEvent[], at: number, revision: number, today: string): LifeJournal {
  const byId = new Map(events.map((event) => [event.id, event]));
  const byDate = new Map<string, LifeEvent[]>();
  for (const event of events) {
    const day = byDate.get(event.date) ?? [];
    day.push(event); byDate.set(event.date, day);
  }
  const previousDiaries = new Map(journal.diaries.map((diary) => [diary.date, diary]));
  const goals = journal.goals.map((goal) => {
    const kept = goal.eventRefs.flatMap((ref) => {
      const event = byId.get(ref.id);
      return event && goalEvidence(event, goal.activity) ? [event] : [];
    });
    const seen = new Set(kept.map((event) => event.id));
    if (goal.status === "active") for (const event of events) {
      if (!seen.has(event.id) && event.startAt >= goal.activeSince && event.endAt <= at && goalEvidence(event, goal.activity)) {
        kept.push(event); seen.add(event.id);
      }
    }
    const eventRefs = refsOf(kept.sort((a, b) => a.endAt - b.endAt));
    return sameRefs(goal.eventRefs, eventRefs) ? structuredClone(goal) : { ...structuredClone(goal), eventRefs, revision, updatedAt: at };
  });
  const cutoff = new Date(`${today}T12:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  const dates = new Set([...journal.diaries.map((diary) => diary.date), ...events.filter((event) => event.date < today
    && event.date >= cutoff.toISOString().slice(0, 10) && event.status !== "revoked").map((event) => event.date)]);
  const diaries = [...dates].sort().flatMap((date) => {
    const diary = diaryFor(previousDiaries.get(date), date, byDate.get(date) ?? [], at, revision);
    return diary ? [structuredClone(diary)] : [];
  });
  return { goals, diaries };
}
