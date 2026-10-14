import type { LifeEvent } from "./life-context";
import type { LifeDiary } from "./life-journal";

export interface LifeDiarySearchHit {
  date: string;
  diary: { id: string; summary: string; source: "model" | "program"; revision: number } | null;
  events: Array<Pick<LifeEvent, "id" | "text" | "status" | "source" | "modelDetail" | "revision">>;
}
export interface LifeDiaryReference { date: string; summary: string; source: "model" | "program" }
export interface LifeDiarySchedule {
  date: string;
  events: Array<{ id: string; text: string; startAt: number; endAt: number;
    status: "materialized"; source: "runtime_schedule"; modelDetail?: string }>;
}

interface RecordEntry { date: string; eventId?: string; text: string }

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, "");

function grams(value: string): string[] {
  const chars = Array.from(normalize(value));
  if (!chars.length) return [];
  if (chars.length === 1) return chars;
  return [...new Set(Array.from({ length: chars.length - 1 }, (_, index) => chars.slice(index, index + 2).join("")))];
}

/** 日记与事件分别入索引，结果按日期归并；索引仅由权威生活状态派生。 */
export function createLifeDiaryIndex(diaries: LifeDiary[], events: LifeEvent[], at: number) {
  const byDate = new Map<string, { diary?: LifeDiary; events: LifeEvent[] }>();
  const records: RecordEntry[] = [];
  const postings = new Map<string, Set<number>>();
  const add = (record: RecordEntry) => {
    const id = records.push(record) - 1;
    const terms = grams(record.text);
    if (/读|书/.test(record.text)) for (const character of ["读", "书"]) {
      if (record.text.includes(character)) terms.push(`char:${character}`);
    }
    for (const gram of terms) {
      const ids = postings.get(gram) ?? new Set<number>();
      ids.add(id);
      postings.set(gram, ids);
    }
  };
  for (const diary of diaries) {
    if (diary.status !== "active" || diary.updatedAt > at) continue;
    const day = byDate.get(diary.date) ?? { events: [] };
    day.diary = diary;
    byDate.set(diary.date, day);
    add({ date: diary.date, text: diary.summary });
  }
  for (const event of events) {
    if (event.status === "revoked" || event.endAt > at) continue;
    const day = byDate.get(event.date) ?? { events: [] };
    day.events.push(event);
    byDate.set(event.date, day);
    add({ date: event.date, eventId: event.id, text: `${event.text} ${event.modelDetail ?? ""}` });
  }
  const hit = (date: string, eventIds?: Set<string>): LifeDiarySearchHit | null => {
    const day = byDate.get(date);
    if (!day) return null;
    return { date, diary: day.diary ? { id: day.diary.id, summary: day.diary.summary,
      source: day.diary.source === "model" ? "model" : "program", revision: day.diary.revision } : null,
    events: day.events.filter((event) => !eventIds || eventIds.has(event.id)).slice(-4)
      .map(({ id, text, status, source, modelDetail, revision }) => ({ id, text, status, source, modelDetail, revision })) };
  };
  return {
    recall(query: string, beforeDate: string, excludeDate: string | undefined, limit = 2): LifeDiaryReference[] {
      const terms = grams(query.slice(0, 500));
      if (!terms.length) return [];
      const scores = new Map<string, number>();
      for (const term of terms) for (const id of postings.get(term) ?? []) {
        const record = records[id];
        if (record.eventId || record.date >= beforeDate || record.date === excludeDate) continue;
        scores.set(record.date, (scores.get(record.date) ?? 0) + 1);
      }
      const minimum = terms.length <= 2 ? 1 : terms.length <= 4 ? 2 : 3;
      return [...scores].filter(([date, score]) => score >= minimum && byDate.get(date)?.diary)
        .sort((left, right) => right[1] - left[1] || right[0].localeCompare(left[0]))
        .slice(0, Math.max(0, Math.min(2, Math.trunc(limit))))
        .map(([date]) => { const diary = byDate.get(date)!.diary!;
          return { date, summary: diary.summary.slice(0, 600), source: diary.source === "model" ? "model" : "program" }; });
    },
    recallEvents(query: string, beforeDate: string, limit = 2): LifeDiarySchedule[] {
      const terms = grams(query.slice(0, 500));
      if (!terms.length) return [];
      const scores = new Map<number, number>();
      for (const term of terms) for (const id of postings.get(term) ?? []) {
        const record = records[id];
        if (!record.eventId || record.date >= beforeDate) continue;
        const event = byDate.get(record.date)?.events.find((item) => item.id === record.eventId);
        if (event?.status !== "materialized" || event.source !== "runtime_schedule") continue;
        scores.set(id, (scores.get(id) ?? 0) + 1);
      }
      const minimum = terms.length <= 2 ? 1 : terms.length <= 4 ? 2 : 3;
      const days = new Map<string, { best: number; eventIds: Set<string> }>();
      for (const [id, score] of scores) {
        if (score < minimum) continue;
        const record = records[id];
        const day = days.get(record.date) ?? { best: 0, eventIds: new Set<string>() };
        day.best = Math.max(day.best, score);
        day.eventIds.add(record.eventId!);
        days.set(record.date, day);
      }
      return [...days].sort((left, right) => right[1].best - left[1].best || right[0].localeCompare(left[0]))
        .slice(0, Math.max(0, Math.min(2, Math.trunc(limit))))
        .map(([date, day]) => ({ date, events: byDate.get(date)!.events
          .filter((event) => day.eventIds.has(event.id)).slice(-4)
          .map(({ id, text, startAt, endAt, status, source, modelDetail }) => ({ id, text, startAt, endAt,
            status: status as "materialized", source: source as "runtime_schedule", ...(modelDetail ? { modelDetail } : {}) })) }));
    },
    search(query: string, limit = 5): LifeDiarySearchHit[] {
      if (typeof query !== "string" || !query.trim()) return [];
      const date = /(?:20\d{2})-\d{2}-\d{2}/.exec(query)?.[0];
      if (date) {
        const found = hit(date);
        return found ? [found] : [];
      }
      const terms = grams(query.slice(0, 160));
      if (/读|书/.test(query)) for (const character of ["读", "书"]) {
        if (query.includes(character)) terms.push(`char:${character}`);
      }
      if (!terms.length) return [];
      const scores = new Map<number, number>();
      for (const term of terms) for (const id of postings.get(term) ?? []) {
        const weight = term === "char:读" && /读过|读了|哪本书/.test(query) ? 3 : 1;
        scores.set(id, (scores.get(id) ?? 0) + weight);
      }
      const days = new Map<string, { best: number; bonus: number; eventIds: Set<string> }>();
      for (const [id, score] of scores) {
        const record = records[id];
        const day = days.get(record.date) ?? { best: 0, bonus: 0, eventIds: new Set<string>() };
        day.best = Math.max(day.best, score);
        day.bonus = Math.min(1, day.bonus + 0.1);
        if (record.eventId) day.eventIds.add(record.eventId);
        days.set(record.date, day);
      }
      return [...days].sort((left, right) => right[1].best + right[1].bonus - left[1].best - left[1].bonus
        || right[0].localeCompare(left[0]))
        .slice(0, Math.max(1, Math.min(10, Math.trunc(limit))))
        .flatMap(([date, day]) => {
          const found = hit(date, day.eventIds);
          return found ? [found] : [];
        });
    },
  };
}
