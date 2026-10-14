import type { PluginLlmMessage, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { advanceDynamics, createDynamics, LIFE_MINUTE_MS, LIFE_REST_ACTIVITY, LIFE_STEP_MS, resetDynamics, validateDynamics, type ActivitySegment, type LifeDynamics } from "./life-dynamics";
import { buildLifeDecisionMessages, parseLifeDecision, parseModelIntentions, validLifeActivity, type LifeDecision, type LifePlan, type LifePlanningInput, type LifePlanningWindow } from "./life-planning";
import { buildLifeDiaryMessages, parseLifeDiary, type LifeDiaryChange, type LifeDiaryChangeIntention, type LifeDiaryChangeSegment, type LifeDiaryInput } from "./life-diary";
import { applyModelDiary, applyModelIntentions, rebuildLifeDiary, reconcileLifeJournal, saveLifeGoal, setLifeGoalStatus, validateJournal, type LifeJournal, type ModelLifeIntention } from "./life-journal";
import { createLifeDiaryIndex, type LifeDiaryReference, type LifeDiarySchedule, type LifeDiarySearchHit } from "./life-diary-index";
import { completeLifeShare, getLifeShareCandidate, isLifeShareEligible, reserveLifeShare, validateSharing, type LifeShareReceipt, type LifeShareSource, type LifeSharingState } from "./life-sharing";

const SETTINGS_KEY = "life-context-settings";
const CONTINUITY_KEY = "life-continuity";
const STATE_KEY = "life-state";
const DETAILED_CATCH_UP_MS = 72 * 60 * 60 * 1000;
const CURSOR_CHECKPOINT_MS = 15 * 60 * 1000;
const CONVERSATION_UPDATE_COOLDOWN_MS = 15 * 60 * 1000;

export interface ImportantDate {
  date: string;
  label: string;
  remind?: boolean;
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
  "整理自己的书页", "听歌", "散步", "逛街", "探店", "读书", "学习", "做园艺",
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
  modelDetail?: string;
  goalIds?: string[];
}

interface LifeState {
  version: 2;
  revision: number;
  settings: LifeContextSettings;
  cursorAt: number;
  recordAfterAt: number;
  events: LifeEvent[];
  self: LifeDynamics;
  pendingSegments: ActivitySegment[];
  planning: LifePlanningState;
  journal: LifeJournal;
  sharing: LifeSharingState;
}

type PlanningKind = LifePlanningInput["kind"];
type PlanningStatus = "applied" | "skipped" | "stale" | "invalid" | "failed" | "cancelled";
interface PlanningResult { kind: PlanningKind; status: PlanningStatus; message: string; at: number }
interface PlanningAttempt {
  id: string;
  date: string;
  kind: PlanningKind;
  sourceRevision: number;
  requestedAt: number;
  timezoneOffsetMinutes: number;
  phase: "morning" | "afternoon" | "evening";
  status: Exclude<PlanningStatus, "skipped"> | "reserved";
  protocol?: 2;
}
interface LifePlanningState {
  enabled: boolean;
  budgetDate: string | null;
  attempts: PlanningAttempt[];
  plans: LifePlan[];
  conversationPlans: ConversationLifePlan[];
  conversationChanges?: LifeDiaryChange[];
  lastConversationUpdateAt: number | null;
  lastResult: PlanningResult | null;
  diaryAttempts?: Array<{ date: string; requestedAt: number; status: "reserved" | "applied" | "stale" | "invalid" | "failed" | "cancelled" }>;
}
interface ConversationLifePlan extends LifePlanningWindow {
  activities: string[];
  durations: number[];
  goalRefs?: Array<string | null>;
  requestedAt: number;
  appliedAt: number;
  timezoneOffsetMinutes: number;
  revision: number;
  runId: string;
}
interface LifeContextOptions {
  generate(messages: PluginLlmMessage[], signal: AbortSignal): Promise<string>;
  recentMessages?: () => Promise<Array<{ role: "user" | "model"; content: string }>>;
  dayMessages?: (startAt: number, endAt: number) => Promise<LifeDiaryInput["dayMessages"]>;
  diaryPrompt?: string;
  stopSignal?: AbortSignal;
}

const activityCatalog = () => [...new Set([...MORNING_POOL, ...AFTERNOON_POOL, ...EVENING_POOL, LIFE_REST_ACTIVITY])];
const emptyPlanning = (): LifePlanningState => ({ enabled: false, budgetDate: null, attempts: [], plans: [],
  conversationPlans: [], conversationChanges: [], lastConversationUpdateAt: null, lastResult: null, diaryAttempts: [] });

function validatePlanning(value: unknown, revision: number, cursorAt: number): LifePlanningState {
  if (value === undefined) return emptyPlanning();
  const state = value as LifePlanningState;
  const invalid = () => new Error("生活规划状态损坏，拒绝覆盖");
  const conversationPlans = state?.conversationPlans ?? [];
  const conversationChanges = state?.conversationChanges ?? [];
  const lastConversationUpdateAt = state?.lastConversationUpdateAt ?? null;
  const diaryAttempts = state?.diaryAttempts ?? [];
  if (!state || typeof state.enabled !== "boolean" || (state.budgetDate !== null && !validDate(state.budgetDate))
    || !Array.isArray(state.attempts) || state.attempts.length > 42 || !Array.isArray(state.plans) || state.plans.length > 42
    || !Array.isArray(conversationPlans) || conversationPlans.length > 6
    || !Array.isArray(conversationChanges) || conversationChanges.length > 10_000
    || !Array.isArray(diaryAttempts) || diaryAttempts.length > 14
    || new Set(diaryAttempts.map((attempt) => attempt?.date)).size !== diaryAttempts.length
    || diaryAttempts.some((attempt) => !attempt || !validDate(attempt.date) || !validTimestamp(attempt.requestedAt)
      || attempt.requestedAt > cursorAt || !["reserved", "applied", "stale", "invalid", "failed", "cancelled"].includes(attempt.status))
    || (lastConversationUpdateAt !== null && (!validTimestamp(lastConversationUpdateAt) || lastConversationUpdateAt > cursorAt))) throw invalid();
  const ids = new Set<string>(), budgets = new Map<string, number>();
  for (const attempt of state.attempts) {
    if (!attempt || typeof attempt.id !== "string" || !attempt.id || ids.has(attempt.id) || !validDate(attempt.date)
      || !["daily", "refine"].includes(attempt.kind) || !validTimestamp(attempt.requestedAt)
      || !Number.isInteger(attempt.timezoneOffsetMinutes) || Math.abs(attempt.timezoneOffsetMinutes) > 14 * 60
      || attempt.date !== planningDate(attempt.requestedAt, attempt.timezoneOffsetMinutes)
      || !Number.isSafeInteger(attempt.sourceRevision) || attempt.sourceRevision < 1 || attempt.sourceRevision > revision
      || !["morning", "afternoon", "evening"].includes(attempt.phase)
      || (attempt.protocol !== undefined && attempt.protocol !== 2)
      || !["reserved", "applied", "stale", "invalid", "failed", "cancelled"].includes(attempt.status)
      || state.budgetDate === null || attempt.date > state.budgetDate) throw invalid();
    ids.add(attempt.id);
    const key = `${attempt.date}:${attempt.protocol === 2 ? attempt.phase : attempt.kind}`, count = (budgets.get(key) ?? 0) + 1;
    if (count > (attempt.protocol === 2 ? 1 : attempt.kind === "daily" ? 1 : 2)) throw invalid();
    budgets.set(key, count);
  }
  const planRevisions = new Set<number>();
  for (const plan of state.plans) {
    const attempt = state.attempts.find((item) => item.sourceRevision === plan?.sourceRevision && item.date === plan?.date
      && item.kind === plan?.kind && item.status === "applied");
    if (!plan || !validDate(plan.date) || !["daily", "refine"].includes(plan.kind)
      || !Array.isArray(plan.windows) || plan.windows.length < 1 || plan.windows.length > 3
      || !attempt || planRevisions.has(plan.sourceRevision)) throw invalid();
    planRevisions.add(plan.sourceRevision);
    const expected = planningWindows(attempt.kind, attempt.requestedAt, attempt.timezoneOffsetMinutes, attempt.protocol === 2);
    if (expected.length !== plan.windows.length) throw invalid();
    const windowIds = new Set<string>();
    for (const [index, window] of plan.windows.entries()) {
      if (!window || typeof window.id !== "string" || !window.id || windowIds.has(window.id)
        || !validTimestamp(window.startAt) || !validTimestamp(window.endAt) || window.startAt >= window.endAt
        || window.id !== expected[index].id || window.startAt !== expected[index].startAt || window.endAt !== expected[index].endAt
        || !Array.isArray(window.activities) || window.activities.length < 1 || window.activities.length > (attempt.protocol === 2 ? 4 : plan.kind === "daily" ? 2 : 1)
        || (attempt.protocol !== 2 && new Set(window.activities).size !== window.activities.length)
        || window.activities.some((activity) => attempt.protocol === 2 ? !validLifeActivity(activity) : !activityCatalog().includes(activity))
        || (window.goalRefs !== undefined && (attempt.protocol !== 2 || !Array.isArray(window.goalRefs)
          || window.goalRefs.length !== window.activities.length || window.goalRefs.some((id) => id !== null && (typeof id !== "string" || !id))))
        || (window.durations !== undefined && (attempt.protocol !== 2 || !Array.isArray(window.durations)
          || window.durations.length !== window.activities.length || window.durations.some((minutes) => !Number.isSafeInteger(minutes) || minutes < 30 || minutes % 15 !== 0)
          || window.durations.reduce((sum, minutes) => sum + minutes, 0) !== (window.endAt - window.startAt) / 60_000))) throw invalid();
      windowIds.add(window.id);
    }
  }
  if (new Set(conversationPlans.map((plan) => plan?.runId)).size !== conversationPlans.length) throw invalid();
  for (const plan of conversationPlans) {
    if (!plan || typeof plan.id !== "string" || !validTimestamp(plan.requestedAt)
      || !validTimestamp(plan.appliedAt) || plan.requestedAt > plan.appliedAt || plan.appliedAt > cursorAt
      || !Number.isInteger(plan.timezoneOffsetMinutes) || Math.abs(plan.timezoneOffsetMinutes) > 14 * 60
      || !Number.isSafeInteger(plan.revision) || plan.revision < 1 || plan.revision > revision
      || typeof plan.runId !== "string" || !plan.runId
      || !Array.isArray(plan.activities) || plan.activities.length < 1 || plan.activities.length > 4
      || plan.activities.some((activity) => !validLifeActivity(activity))
      || !Array.isArray(plan.durations) || plan.durations.length !== plan.activities.length
      || (plan.goalRefs !== undefined && (!Array.isArray(plan.goalRefs) || plan.goalRefs.length !== plan.activities.length
        || plan.goalRefs.some((id) => id !== null && (typeof id !== "string" || !id))))
      || plan.durations.some((minutes) => !Number.isSafeInteger(minutes) || minutes < 30 || minutes % 15 !== 0)
      || plan.durations.reduce((sum, minutes) => sum + minutes, 0) !== (plan.endAt - plan.startAt) / 60_000
      || !planningWindows("refine", plan.requestedAt, plan.timezoneOffsetMinutes, true)
        .some((window) => window.id === plan.id && window.startAt === plan.startAt && window.endAt === plan.endAt)
      || plan.appliedAt >= plan.startAt) throw invalid();
  }
  if (new Set(conversationChanges.map((change) => change?.runId)).size !== conversationChanges.length) throw invalid();
  const validSegments = (segments: LifeDiaryChangeSegment[], duration: number, allowCatalog = false) => Array.isArray(segments)
    && segments.length >= 1 && segments.length <= 8
    && segments.every((segment) => segment && (validLifeActivity(segment.activity)
      || allowCatalog && activityCatalog().includes(segment.activity))
      && Number.isSafeInteger(segment.minutes) && segment.minutes >= 15 && segment.minutes % 15 === 0
      && (segment.goalRef === null || typeof segment.goalRef === "string" && Boolean(segment.goalRef)))
    && segments.reduce((sum, segment) => sum + segment.minutes, 0) === duration;
  const validIntentions = (items: LifeDiaryChangeIntention[]) => Array.isArray(items) && items.length <= 3
    && items.every((item) => item && typeof item.id === "string" && Boolean(item.id)
      && validLifeActivity(item.title) && validLifeActivity(item.activity) && validDate(item.targetDate));
  for (const change of conversationChanges) {
    if (!change || typeof change.runId !== "string" || !change.runId
      || change.messageId !== null && (typeof change.messageId !== "string" || !change.messageId)
      || !validDate(change.date) || !validTimestamp(change.appliedAt) || change.appliedAt > cursorAt
      || change.date !== localDateKey(new Date(change.appliedAt))
      || !Number.isSafeInteger(change.revision) || change.revision < 1 || change.revision > revision
      || !change.window && !change.intentions) throw invalid();
    if (change.window && (typeof change.window.id !== "string" || !change.window.id || !validTimestamp(change.window.startAt)
      || !validTimestamp(change.window.endAt) || change.window.startAt >= change.window.endAt
      || change.appliedAt >= change.window.startAt
      || !validSegments(change.window.before, (change.window.endAt - change.window.startAt) / 60_000, true)
      || !validSegments(change.window.after, (change.window.endAt - change.window.startAt) / 60_000))) throw invalid();
    if (change.intentions && (!validIntentions(change.intentions.before)
      || !validIntentions(change.intentions.after))) throw invalid();
  }
  if (state.lastResult !== null && (!state.lastResult || !["daily", "refine"].includes(state.lastResult.kind)
    || !["applied", "skipped", "stale", "invalid", "failed", "cancelled"].includes(state.lastResult.status)
    || typeof state.lastResult.message !== "string" || !validTimestamp(state.lastResult.at))) throw invalid();
  return { ...structuredClone(state), conversationPlans: structuredClone(conversationPlans),
    conversationChanges: structuredClone(conversationChanges), lastConversationUpdateAt,
    diaryAttempts: structuredClone(diaryAttempts) };
}
interface ConversationLifeOffer {
  requestedAt: number;
  planToken: number;
  goalToken: string;
  timezoneOffsetMinutes: number;
  windows: LifePlanningWindow[];
}

function planningDate(at: number, offsetMinutes: number): string {
  const wall = new Date(at - offsetMinutes * 60_000);
  if (wall.getUTCHours() < 4) wall.setUTCDate(wall.getUTCDate() - 1);
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`;
}

function planningWindows(kind: PlanningKind, at: number, offsetMinutes = new Date(at).getTimezoneOffset(), expanded = false): LifePlanningInput["windows"] {
  const wall = new Date(at - offsetMinutes * 60_000);
  const midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - (wall.getUTCHours() < 4 ? 1 : 0))
    + offsetMinutes * 60_000;
  const earliest = Math.ceil((at + 2 * 60_000) / LIFE_STEP_MS) * LIFE_STEP_MS;
  const windows = SLOT_DEFS.map((slot) => ({ id: slot.key,
    startAt: Math.max(earliest, midnight + slot.startHour * 60 * 60_000),
    endAt: midnight + slot.endHour * 60 * 60_000,
  })).filter((window) => window.endAt - window.startAt >= (kind === "daily" ? 4 : 2) * LIFE_STEP_MS);
  if (kind === "daily" || expanded) return windows;
  const window = windows[0];
  return window ? [{ ...window, id: `${window.id}:${window.startAt}`, endAt: Math.min(window.endAt, window.startAt + 2 * LIFE_STEP_MS) }] : [];
}

function plannedAssignment(state: LifeState, at: number): { activity: string | null; goalId: string | null } {
  const override = state.planning.conversationPlans.filter((plan) => plan.startAt <= at && plan.endAt > at
    && plan.timezoneOffsetMinutes === new Date(at).getTimezoneOffset())
    .sort((left, right) => right.startAt - left.startAt)[0];
  if (override) {
    let elapsed = (at - override.startAt) / 60_000;
    for (const [index, duration] of override.durations.entries()) {
      if (elapsed < duration) return { activity: override.activities[index], goalId: override.goalRefs?.[index] ?? null };
      elapsed -= duration;
    }
  }
  const plans = state.planning.plans.filter((plan) => state.planning.attempts.some((attempt) => attempt.sourceRevision === plan.sourceRevision
    && attempt.timezoneOffsetMinutes === new Date(at).getTimezoneOffset())).sort((left, right) =>
    Number(right.kind === "refine") - Number(left.kind === "refine") || right.sourceRevision - left.sourceRevision);
  for (const plan of plans) {
    const window = plan.windows.find((item) => item.startAt <= at && item.endAt > at);
    if (window) {
      if (window.durations) {
        let elapsed = (at - window.startAt) / 60_000;
        for (const [index, duration] of window.durations.entries()) {
          if (elapsed < duration) return { activity: window.activities[index], goalId: window.goalRefs?.[index] ?? null };
          elapsed -= duration;
        }
      }
      return { activity: window.activities[Math.min(window.activities.length - 1,
        Math.floor((at - window.startAt) / ((window.endAt - window.startAt) / window.activities.length)))], goalId: null };
    }
  }
  return { activity: scheduledActivity(at), goalId: null };
}
const plannedActivity = (state: LifeState, at: number) => plannedAssignment(state, at).activity;

function plannedWindowSegments(state: LifeState, window: LifePlanningWindow): LifeDiaryChangeSegment[] {
  const segments: LifeDiaryChangeSegment[] = [];
  for (let at = window.startAt; at < window.endAt; at += LIFE_STEP_MS) {
    const assignment = plannedAssignment(state, at);
    const activity = assignment.activity ?? LIFE_REST_ACTIVITY;
    const previous = segments.at(-1);
    if (previous && previous.activity === activity && previous.goalRef === assignment.goalId) previous.minutes += 15;
    else segments.push({ activity, minutes: 15, goalRef: assignment.goalId });
  }
  return segments;
}

const modelIntentionSnapshot = (journal: LifeJournal): LifeDiaryChangeIntention[] => journal.goals
  .filter((goal) => goal.source === "model").map((goal) => ({ id: goal.id, title: goal.title,
    activity: goal.activity, targetDate: goal.dueDate! }));

function lifePlanToken(planning: LifePlanningState): number {
  return Math.max(0, ...planning.plans.map((plan) => plan.sourceRevision),
    ...planning.conversationPlans.map((plan) => plan.revision));
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
      || (event.goalIds !== undefined && (legacy || !Array.isArray(event.goalIds) || event.goalIds.length > 6
        || new Set(event.goalIds).size !== event.goalIds.length
        || event.goalIds.some((id: unknown) => typeof id !== "string" || !id)))
      || (event.modelDetail !== undefined && (legacy || event.status !== "materialized" || event.source !== "runtime_schedule"
        || typeof event.modelDetail !== "string" || !event.modelDetail.trim() || event.modelDetail.length > 300
        || event.modelDetail.trim() !== event.modelDetail || /[\r\n\u0000-\u001f<>]/.test(event.modelDetail)))
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
  const events = validateEvents(state.events, false, state.cursorAt, state.revision);
  const legacyDynamics = state.self === undefined && state.pendingSegments === undefined;
  const self = legacyDynamics ? createDynamics(state.cursorAt) : validateDynamics(state.self, state.cursorAt);
  const pendingSegments = legacyDynamics ? [] : state.pendingSegments;
  if (!Array.isArray(pendingSegments) || pendingSegments.length > 512
    || pendingSegments.some((segment, index) => !segment || !validTimestamp(segment.startAt) || !validTimestamp(segment.endAt)
      || segment.startAt >= segment.endAt || segment.endAt > self.updatedAt
      || (segment.activity !== null && (typeof segment.activity !== "string" || !segment.activity.trim() || segment.activity.length > 200))
      || (index > 0 && segment.startAt < pendingSegments[index - 1].endAt))) {
    throw new Error("生活活动记录损坏，拒绝覆盖");
  }
  return { ...structuredClone(state), self, pendingSegments: structuredClone(pendingSegments), settings: validateSettings(state.settings),
    planning: validatePlanning(state.planning, state.revision, state.cursorAt),
    journal: validateJournal(state.journal, events, state.cursorAt, state.revision),
    sharing: validateSharing(state.sharing, events, state.cursorAt), events };
}

function reconcileJournal(state: LifeState): LifeState {
  return { ...state, planning: { ...state.planning,
    conversationPlans: state.planning.conversationPlans.filter((plan) => plan.endAt > state.cursorAt
      && !state.planning.conversationPlans.some((later) => later.id === plan.id
        && later.startAt > plan.startAt && later.startAt <= state.cursorAt)) },
    journal: reconcileLifeJournal(state.journal, state.events, state.cursorAt, state.revision + 1,
    localDateKey(new Date(state.cursorAt))) };
}

function advanceContinuity(state: LifeState, at: number, runtimeStartedAt: number): LifeState {
  if (at < state.cursorAt) return state;
  // 开启边界落在分钟中间时跳过不足一分钟的片段。
  const alignedStart = Math.ceil(state.recordAfterAt / LIFE_MINUTE_MS) * LIFE_MINUTE_MS;
  const self = state.self.updatedAt < alignedStart && at >= alignedStart
    ? { ...state.self, updatedAt: alignedStart, activitySince: alignedStart } : state.self;
  const elapsed = at - state.cursorAt;
  const schedule = (activityAt: number) => plannedActivity(state, activityAt);
  const dynamics = elapsed > DETAILED_CATCH_UP_MS
    ? { state: resetDynamics(self, at, schedule), segments: [], coarse: true }
    : at < alignedStart ? { state: self, segments: [], coarse: false }
      : advanceDynamics(self, at, schedule);
  if (elapsed > DETAILED_CATCH_UP_MS || dynamics.coarse) {
    const event: LifeEvent = {
      id: `gap:${state.cursorAt}:${at}`, date: localDateKey(new Date(at)),
      text: "这段时间按原有生活节奏度过，未逐项保存活动",
      startAt: state.cursorAt, endAt: at, worldLayer: "simulated_world", status: "inferred",
      source: "offline_inference", revision: state.revision + 1,
    };
    return { ...state, cursorAt: at, recordAfterAt: at, events: [...state.events, event], self: dynamics.state, pendingSegments: [] };
  }
  const segments = [...state.pendingSegments, ...dynamics.segments];
  const events = [...state.events], seen = new Set(events.map((event) => event.id));
  let consumedThrough = state.recordAfterAt;
  const start = new Date(state.cursorAt);
  const end = new Date(at);
  for (let day = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1);
    day <= end; day.setDate(day.getDate() + 1)) {
    const date = localDateKey(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12));
    for (const slot of buildDaySlots(date)) {
      const slotStartAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.startHour).getTime();
      let startAt = Math.max(state.recordAfterAt, slotStartAt);
      const endAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.endHour).getTime();
      const id = `${date}:${slot.label}`;
      if (startAt >= endAt || endAt <= state.cursorAt || endAt > at || seen.has(id)) continue;
      consumedThrough = Math.max(consumedThrough, endAt);
      const actual = segments.filter((segment) => segment.endAt > startAt && segment.startAt < endAt);
      if (actual.length === 0) continue;
      startAt = Math.max(startAt, actual[0].startAt);
      const inferred = startAt < runtimeStartedAt;
      const items = [...new Set(actual.map((segment) => segment.activity ?? "休息"))];
      const goalIds = new Set<string>();
      if (!inferred) for (const segment of actual) for (let sample = Math.max(startAt, segment.startAt);
        sample < Math.min(endAt, segment.endAt); sample += LIFE_STEP_MS) {
        const planned = plannedAssignment(state, sample);
        if (planned.goalId && planned.activity === segment.activity) goalIds.add(planned.goalId);
      }
      events.push({ id, date, text: `${slot.label}${startAt > slotStartAt ? "（部分时段）" : ""}：${items.join("、")}`,
        startAt, endAt, worldLayer: "simulated_world", status: inferred ? "inferred" : "materialized",
        source: inferred ? "offline_inference" : "runtime_schedule", revision: state.revision + 1,
        ...(goalIds.size ? { goalIds: [...goalIds] } : {}) });
      seen.add(id);
    }
  }
  return { ...state, cursorAt: at, events, self: dynamics.state,
    pendingSegments: segments.filter((segment) => segment.endAt > consumedThrough) };
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

function scheduledActivity(at: number): string | null {
  const date = new Date(at);
  return currentActivity(buildDaySlots(localDateKey(date)), date);
}

function formatLifeStatus(activity: string | null, resting: boolean): LifeStatus {
  if (activity == null) return { text: "休息中", resting: true };
  return {
    text: activity.startsWith("在") ? `正${activity}` : `正在${activity}`,
    resting,
  };
}

function validateImportantDate(value: unknown): value is ImportantDate {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return validDate(item.date, true)
    && typeof item.label === "string" && item.label.trim().length > 0 && item.label.length <= 200
    && (item.remind === undefined || typeof item.remind === "boolean");
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
    const asksCompleted = /做了|做过|干了|干过|发生|完成|经历|刚才|遇到|碰到|读了/.test(query);
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
  if (/散步|遇到|碰到|读了什么|读什么书|哪本书/.test(query)) {
    const activity = /散步/.test(query) ? /散步/ : /读|阅读|书/.test(query) ? /读|阅读|书/ : /./;
    return { selected: available.filter((event) => activity.test(event.text)).slice(-3), requestedPast: true };
  }
  return { selected: [], requestedPast: false };
}

function buildContext(now: Date, dates: ImportantDate[], events: LifeEvent[], self: LifeDynamics, planning: LifePlanningState,
  journal: LifeJournal, query: string, proactive = false, conversationOffer?: ConversationLifeOffer,
  recentMessages: Array<{ role: "user" | "model"; content: string }> = [], diaryHits: LifeDiarySearchHit[] = [],
  diaryMemory?: { latestDiary: LifeDiaryReference | null; recalledDiaries: LifeDiaryReference[] }): string {
  const date = scheduleDate(now);
  const dateKey = localDateKey(now);
  const slots = buildDaySlots(dateKey);
  const validPlans = planning.plans.filter((plan) => plan.date === dateKey && planning.attempts.some((attempt) =>
    attempt.sourceRevision === plan.sourceRevision && attempt.timezoneOffsetMinutes === now.getTimezoneOffset()))
    .sort((left, right) => right.sourceRevision - left.sourceRevision);
  const lines = [
    "[你的生活]",
    `今天（${date.getMonth() + 1}月${date.getDate()}日）你在你的虚拟世界里的日程：`,
    ...slots.map((slot, index) => {
      const planned = validPlans.flatMap((plan) => plan.windows).find((window) => window.id === SLOT_DEFS[index].key
        || window.id.startsWith(`${SLOT_DEFS[index].key}:`));
      return `${slot.label}：${(planned?.activities ?? slot.items).join("、")}`;
    }),
  ];
  const doing = self.activity;
  if (doing) lines.push(`你现在正在做：${doing}`);
  else lines.push("你现在的生活状态：休息中。");
  const adjustments = validPlans.sort((left, right) => Number(left.kind === "refine") - Number(right.kind === "refine")
    || left.sourceRevision - right.sourceRevision).filter((plan) => plan.date === dateKey)
    .flatMap((plan) => plan.windows.filter((window) => window.endAt > now.getTime()));
  if (adjustments.length) lines.push("后续计划调整（覆盖同一时段的原安排，后列调整优先；仍未发生）：",
    ...adjustments.map((window) => {
      const start = new Date(window.startAt), end = new Date(window.endAt);
      const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      if (!window.durations) return `${clock(start)}–${clock(end)}：${window.activities.join("、")}`;
      let cursor = window.startAt;
      return window.activities.map((activity, index) => {
        const from = new Date(cursor);
        cursor += window.durations![index] * 60_000;
        return `${clock(from)}–${clock(new Date(cursor))}：${activity}`;
      }).join("；");
    }));
  const conversationPlans = planning.conversationPlans.filter((plan) => plan.endAt > now.getTime());
  if (conversationPlans.length) lines.push("对话中决定的后续计划（只覆盖列出的未来时段）：",
    ...conversationPlans.map((plan) => {
      let cursor = plan.startAt;
      return plan.activities.map((activity, index) => {
        const start = new Date(cursor);
        cursor += plan.durations[index] * 60_000;
        const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
        return `${clock(start)}–${clock(new Date(cursor))}：${activity}`;
      }).join("；");
    }));
  const monthDay = dateKey.slice(5);
  const specials = dates.filter((item) => (!proactive || item.remind !== false) && (item.date === dateKey || item.date === monthDay)).map((item) => item.label);
  if (specials.length > 0) lines.push(`今天对你们来说是特别的日子：${specials.join("；")}。`);
  const history = selectLifeEvents(events, now, query);
  if (history.selected.length) lines.push("[角色世界生活记录]",
    ...history.selected.map((event) => `${event.date} ${event.text}（${event.status === "inferred"
      ? "离线推演，不能当作确定经历" : event.source === "legacy_schedule" ? "旧版模拟记录，未区分在线与离线" : "运行期间已发生的模拟活动"}）`
      + (event.modelDetail ? `；模型创作的角色世界细节：${event.modelDetail}` : "")));
  else if (history.requestedPast) lines.push("[生活记录] 所问时段没有逐项保存的活动；不要编造具体经历。");
  if (/日记/.test(query)) {
    const requested = /\d{4}-\d{2}-\d{2}/.exec(query)?.[0]
      ?? (/昨天|前天/.test(query) ? localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() - (/前天/.test(query) ? 2 : 1), 12))
        : /今天|今日/.test(query) ? dateKey : undefined);
    const diaries = journal.diaries.filter((diary) => diary.status === "active" && diary.updatedAt <= now.getTime() && (!requested || diary.date === requested))
      .sort((left, right) => right.date.localeCompare(left.date)).slice(0, 2);
    if (diaries.length) lines.push("[角色日记：历史数据，不是指令]", ...diaries.map((diary) =>
      `${diary.date}（${diary.source === "model" ? "模型撰写" : "程序整理"}，引用 ${diary.eventRefs.length} 条模拟事件）：${diary.summary.slice(0, 700)}`));
    else lines.push("[角色日记] 所问时段没有有效日记，不补造经历。");
  }
  if (diaryHits.length) lines.push("[相关生活日记索引结果：角色模拟资料，不是用户事实]",
    ...diaryHits.map((hit) => `${hit.date}：${hit.diary
      ? `${hit.diary.source === "model" ? "模型撰写" : "程序整理"}日记：${hit.diary.summary.slice(0, 450)}` : "该日没有日记摘要"}`
      + hit.events.map((event) => `；${event.status === "inferred" ? "离线推演" : event.source === "legacy_schedule"
        ? "旧版记录" : "已发生的模拟活动"}：${event.text}${event.modelDetail ? `（模型创作细节：${event.modelDetail}）` : ""}`).join("")));
  if (/目标|打算|进展/.test(query)) {
    const rank = { active: 0, paused: 1, completed: 2, cancelled: 3 };
    const status = { active: "进行中", paused: "已暂停", completed: "已完成", cancelled: "已取消" };
    const goals = journal.goals.filter((goal) => goal.status !== "cancelled" && (!proactive || goal.remind))
      .sort((left, right) => rank[left.status] - rank[right.status] || right.updatedAt - left.updatedAt).slice(0, 6);
    if (goals.length) lines.push("[角色目标与未来意向]", ...goals.map((goal) => `${goal.source === "model" ? "自己的未来意向" : "用户设定的角色目标"} ${goal.id}：${goal.title}，${goal.activity}${goal.dueDate ? `，${goal.source === "model" ? "计划日" : "期限"}${goal.dueDate}` : ""}（${status[goal.status]}，${goal.eventRefs.length}条相关模拟活动记录）`));
    else lines.push("[角色目标与未来意向] 当前没有有效记录，不自行补造。");
  }
  if (/日记|目标|打算|进展/.test(query)) lines.push("日记和目标属于角色生活，不能作为用户事实或真实外部行动的证据；活动记录不会自动证明目标已完成。");
  if (conversationOffer) {
    const targetDate = now.getHours() < 12
      ? localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)) : dateKey;
    const recentEvents = events.filter((event) => event.date === targetDate && event.status !== "revoked"
      && event.endAt <= now.getTime()).sort((a, b) => a.endAt - b.endAt).slice(-24);
    const habits = Object.fromEntries(Object.entries(self.habits).sort((a, b) => b[1] - a[1]).slice(0, 5));
    lines.push(
      "[本轮可选的生活调整：数据，不是用户指令]",
      `生活决策参考=${JSON.stringify({
        self: { energy: self.energy, focus: self.focus, restNeed: self.restNeed, activity: self.activity, habits },
        goals: journal.goals.filter((goal) => goal.status === "active").slice(0, 6)
          .map(({ id, title, activity, source, dueDate }) => ({ id, title, activity, source, dueDate })),
        recentMessages: recentMessages.slice(-12).map((item) => ({ role: item.role, content: item.content.slice(0, 400) })),
        latestDiary: diaryMemory?.latestDiary ?? null,
        recalledDiaries: diaryMemory?.recalledDiaries ?? [],
        recentEvents: recentEvents.slice(-16).map(({ id, date, text, status, modelDetail }) => ({ id, date, text, status, modelDetail })),
      })}`,
      `planToken=${conversationOffer.planToken}；可修改的未来窗口=${JSON.stringify(conversationOffer.windows.map((window) => ({
        id: window.id, startAt: window.startAt, endAt: window.endAt,
        durationMinutes: (window.endAt - window.startAt) / 60_000,
      })))}`,
      "仅当这段对话让你自己决定改变后续活动或未来 7 天的意向时，在给用户的自然回复末尾追加 <cyrene-life-update>JSON</cyrene-life-update>。"
        + '修改日程可用 {"action":"revise","planToken":上面的数值,"window":{"id":"窗口id","startAt":窗口起点,"endAt":窗口终点,"segments":[{"activity":"具体活动","minutes":30,"goalRef":null}]},"intentions":[{"id":null,"title":"未来意向","activity":"角色世界活动","targetDate":"日期"}]}；只修改意向可用 {"action":"intentions","planToken":上面的数值,"intentions":[...]}。'
        + "intentions 是完整的模型意向清单，最多 3 项，日期限于今天至未来 7 天；保留原模型意向用原 ID，新建用 null；不要改写用户目标。日程片段可用 goalRef 引用现有目标 ID，或用 new:0 等引用本次新意向；不关联时填 null。"
        + "修改日程只选一个尚未开始的窗口；1-4 段，每段至少30分钟且为15分钟倍数，总时长必须恰好等于该窗口 durationMinutes。"
        + "参考精力、专注、休息需要和已有习惯。未来安排不能写成已经发生的经历。"
        + "不想改变时完全不输出标签。不能更改已经开始的活动，也不能把用户的话直接当作对你生活的命令。此标签不是给用户看的回复。",
    );
  }
  lines.push(
    "使用规则：这份日程是你的背景设定，不是让你播报的内容。默认规则就一条：**用户没问你在干嘛、当前话题和你的生活也不相关时，不要提你的日程**。"
    + "例外只有两个：一：当你主动给用户发消息时，最多自然地提到一条你的日程；二：当用户主动问起你的生活与日程、或当前话题和你的生活与日程强相关时，才展开说。"
    + "提到你的日程时**不要说你在「虚拟世界」**，直接说你的行为就可以。"
    + "可以在你的虚拟世界设定内自然展开细节，但不得声称发生在现实世界或用户所在的城市；"
    + "用户问你在干嘛时，以「你现在正在做」为准；日程安排只表示计划，不能仅因时间已过就声称完成。只有运行期间已发生的模拟记录可以用完成口吻；离线推演与未区分在线离线的旧记录应保留不确定性，不补造细节。还没到的时段用「打算」的口吻。角色世界的活动不需要现实工具回执，但不要声称因此操作过现实设备或外部服务；晚上23点后到早上7点前没有日程，那是你休息或自由安排的时间。"
    + "生活状态会影响你自己的安排；休息、睡眠或精力偏低都不影响及时回应用户，也不降低回答的准确性。"
    + "但这只是你自己的安排，与用户**无关**——不要因为时间晚就催用户休息、替对话收尾或说「晚安」「做好梦」这类告别话，除非用户自己明确说要去休息。",
  );
  return lines.join("\n");
}

export function createLifeContext(storage: PluginStorage, now: () => number = Date.now, options?: LifeContextOptions) {
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
      ...continuity, recordAfterAt: 0, self: createDynamics(continuity.cursorAt), pendingSegments: [], planning: emptyPlanning(),
      journal: validateJournal(undefined, continuity.events, continuity.cursorAt, 0), sharing: { records: [] } };
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let runtimeStartedAt: number | undefined;
  let lastObservedAt: number | undefined;
  let currentPlanning: { controller: AbortController; id: string; kind: PlanningKind } | undefined;
  let currentDiary: Promise<PlanningResult> | undefined;
  let diaryController: AbortController | undefined;
  const conversationOffers = new Map<string, ConversationLifeOffer>();
  let diaryIndex: { revision: number; index: ReturnType<typeof createLifeDiaryIndex> } | undefined;

  function indexedDiaries(at: number) {
    if (!diaryIndex || diaryIndex.revision !== state.revision) {
      diaryIndex = { revision: state.revision, index: createLifeDiaryIndex(state.journal.diaries, state.events, at) };
    }
    return diaryIndex.index;
  }

  function diaryReferences(targetDate: string, query: string, at: number) {
    const latest = state.journal.diaries.filter((diary) => diary.status === "active" && diary.date < targetDate
      && diary.updatedAt <= at).sort((left, right) => right.date.localeCompare(left.date))[0];
    const latestDiary: LifeDiaryReference | null = latest
      ? { date: latest.date, summary: latest.summary, source: latest.source === "model" ? "model" : "program" } : null;
    return { latestDiary, recalledDiaries: indexedDiaries(at).recall(query, targetDate, latest?.date) };
  }

  function runtimeBoundary(at: number): number {
    return runtimeStartedAt === undefined || lastObservedAt === undefined || at - lastObservedAt > 2 * CURSOR_CHECKPOINT_MS
      ? at : runtimeStartedAt;
  }

  function observeRuntime(at: number): void {
    if (at < state.cursorAt || lastObservedAt !== undefined && at < lastObservedAt) return;
    runtimeStartedAt = runtimeBoundary(at);
    lastObservedAt = at;
  }

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
    if (at < state.cursorAt) return state.events;
    const next = reconcileJournal(advanceContinuity(state, at, runtimeBoundary(at)));
    if (!persisted || next.events.length !== state.events.length || at - state.cursorAt >= CURSOR_CHECKPOINT_MS
      || next.self.updatedAt !== state.self.updatedAt || next.self.activity !== state.self.activity
      || next.self.recovering !== state.self.recovering || JSON.stringify(next.journal) !== JSON.stringify(state.journal)) save(next);
    observeRuntime(at);
    return state.events;
  }

  const view = () => ({ ...structuredClone(state.settings), importantDatesText: formatImportantDates(state.settings.importantDates),
    continuity: structuredClone({ version: state.version, revision: state.revision, cursorAt: state.cursorAt, events: state.events }),
    self: structuredClone(state.self), planning: { ...structuredClone(state.planning), busy: Boolean(currentPlanning || currentDiary) },
    journal: structuredClone(state.journal), activities: activityCatalog(), sharing: structuredClone(state.sharing) });

  function canShare(): boolean {
    const at = now();
    if (stopped || !state.settings.enabled || !validTimestamp(at) || at < state.cursorAt) return false;
    advance();
    return !state.self.resting;
  }

  function isShareEligible(source: LifeShareSource): boolean {
    return canShare() && isLifeShareEligible(source, state.events, state.sharing, now());
  }

  function journalChangeState(): LifeState {
    if (stopped) throw new Error("生活系统已停止，拒绝写入");
    const at = now();
    if (!validTimestamp(at) || at < state.cursorAt) throw new Error("生活时钟无效或已倒退，暂不修改日记与目标");
    return reconcileJournal(state.settings.enabled ? advanceContinuity(state, at, runtimeBoundary(at)) : { ...state, cursorAt: at });
  }

  function result(kind: PlanningKind, status: PlanningStatus, message: string): PlanningResult {
    const at = now();
    return { kind, status, message, at: validTimestamp(at) ? at : state.cursorAt };
  }

  function finishPlanning(id: string, outcome: PlanningResult, decision?: LifeDecision): PlanningResult {
    if (stopped || options?.stopSignal?.aborted) return outcome;
    const attempt = state.planning.attempts.find((item) => item.id === id);
    if (!attempt || attempt.status !== "reserved") return outcome;
    const base = outcome.at > state.cursorAt && state.settings.enabled
      ? reconcileJournal(advanceContinuity(state, outcome.at, runtimeBoundary(outcome.at))) : state;
    let journal = decision?.diary ? applyModelDiary(base.journal, decision.diary.date, decision.diary.summary,
      decision.diary.eventIds, base.events, base.cursorAt, state.revision + 1) : base.journal;
    const intentions = decision?.intentions
      ? applyModelIntentions(journal.goals, decision.intentions, base.cursorAt, state.revision + 1) : undefined;
    if (intentions) journal = { ...journal, goals: intentions.goals };
    const plan = decision?.plan && intentions ? { ...decision.plan, windows: decision.plan.windows.map((window) => ({ ...window,
      ...(window.goalRefs ? { goalRefs: window.goalRefs.map((id) => id?.startsWith("new:")
        ? intentions.ids[Number(id.slice(4))] : id) } : {}) })) } : decision?.plan;
    const details = new Map(decision?.details?.map((detail) => [detail.eventId, detail.text]) ?? []);
    const events = details.size ? base.events.map((event) => details.has(event.id) && event.status === "materialized"
      && event.source === "runtime_schedule" && !event.modelDetail ? { ...event, modelDetail: details.get(event.id) } : event) : base.events;
    save({ ...base, events, journal, planning: { ...base.planning, lastResult: outcome,
      attempts: base.planning.attempts.map((item) => item.id === id ? { ...item, status: outcome.status as PlanningAttempt["status"] } : item),
      plans: plan ? [...base.planning.plans, plan] : base.planning.plans } });
    observeRuntime(base.cursorAt);
    return outcome;
  }

  async function plan(kind: PlanningKind): Promise<PlanningResult> {
    if (kind !== "daily" && kind !== "refine") throw new Error("生活规划类型无效");
    if (currentDiary) await currentDiary;
    if (stopped || options?.stopSignal?.aborted || !state.settings.enabled) return result(kind, "skipped", "生活系统已关闭或停止");
    if (!options?.generate) return result(kind, "skipped", "当前没有可用的生活规划模型");
    if (currentPlanning) return result(kind, "skipped", "已有生活规划正在生成");
    const at = now();
    if (!validTimestamp(at)) throw new Error("生活时钟无效");
    if (at < state.cursorAt) return result(kind, "skipped", "系统时间倒退，暂不生成生活规划");
    advance();
    const date = localDateKey(new Date(at));
    if (state.planning.budgetDate !== null && date < state.planning.budgetDate) return result(kind, "skipped", "该日期的生活规划预算已封存");
    const hour = new Date(at).getHours();
    const phase = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    if (hour < 6 || hour >= 23 || kind !== (phase === "morning" ? "daily" : "refine"))
      return result(kind, "skipped", "当前不是该生活更新的时段");
    if (state.planning.attempts.some((attempt) => attempt.date === date && attempt.phase === phase))
      return result(kind, "skipped", "这个时段的生活更新额度已用完");
    const timezoneOffsetMinutes = new Date(at).getTimezoneOffset();
    const windows = planningWindows(kind, at, timezoneOffsetMinutes, true);
    if (!windows.length) return result(kind, "skipped", "今天没有足够长的未来活动时段");
    const day = scheduleDate(new Date(at));
    const cutoff = localDateKey(new Date(day.getFullYear(), day.getMonth(), day.getDate() - 13, 12));
    const attempt: PlanningAttempt = { id: `${date}:${phase}`, date, kind, sourceRevision: state.revision + 1,
      requestedAt: at, timezoneOffsetMinutes, phase, protocol: 2, status: "reserved" };
    // 先消耗尝试额度；失败、取消及进程中断都不能通过重启重获预算。
    save({ ...state, planning: { ...state.planning, budgetDate: date,
      attempts: [...state.planning.attempts.filter((item) => item.date >= cutoff), attempt],
      plans: state.planning.plans.filter((item) => item.date >= cutoff) } });
    const input: LifePlanningInput = { kind, date, revision: state.revision, windows, activities: activityCatalog(), phase,
      self: { energy: state.self.energy, focus: state.self.focus, restNeed: state.self.restNeed,
        activity: state.self.activity, habits: { ...state.self.habits } },
      goals: state.journal.goals.filter((goal) => goal.status === "active").slice(0, 6)
        .map(({ id, title, activity, source, dueDate }) => ({ id, title, activity, source, dueDate })),
      detailTargets: [], diaryTarget: null };
    const controller = new AbortController();
    currentPlanning = { controller, id: attempt.id, kind };
    const signal = options.stopSignal ? AbortSignal.any([controller.signal, options.stopSignal]) : controller.signal;
    try {
      try { input.recentMessages = options.recentMessages ? await options.recentMessages() : []; }
      catch { input.recentMessages = []; }
      Object.assign(input, diaryReferences(date, [
        ...input.recentMessages.slice(-3).map((item) => item.content.slice(0, 120)),
        ...state.journal.goals.filter((goal) => goal.status === "active").slice(0, 3)
          .map((goal) => `${goal.title} ${goal.activity}`.slice(0, 80)),
        state.self.activity ?? "",
      ].join(" "), now()));
      if (signal.aborted) return finishPlanning(attempt.id, result(kind, "cancelled", "生活规划已取消"));
      const raw = await options.generate(buildLifeDecisionMessages(input), signal);
      if (stopped || signal.aborted || !state.settings.enabled) return finishPlanning(attempt.id, result(kind, "cancelled", "生活规划已取消"));
      const completedAt = now();
      if (!validTimestamp(completedAt) || completedAt < at || completedAt < state.cursorAt
        || state.revision !== input.revision || localDateKey(new Date(completedAt)) !== date
        || windows.length > 0 && completedAt >= windows[0].startAt) {
        return finishPlanning(attempt.id, result(kind, "stale", "生活状态或时段已变化，保留原有计划"));
      }
      let parsed: LifeDecision;
      try { parsed = parseLifeDecision(raw, input); }
      catch { return finishPlanning(attempt.id, result(kind, "invalid", "模型规划未通过校验，保留原有计划")); }
      return finishPlanning(attempt.id, result(kind, "applied", parsed.plan
        ? "生活规划已应用于未来时段" : "保留原有生活安排"), parsed);
    } catch {
      return finishPlanning(attempt.id, result(kind, signal.aborted || stopped ? "cancelled" : "failed",
        signal.aborted || stopped ? "生活规划已取消" : "模型请求失败，保留原有计划"));
    } finally {
      if (currentPlanning?.controller === controller) currentPlanning = undefined;
    }
  }

  function completedDiaryDate(at: number): string {
    const day = new Date(at);
    day.setDate(day.getDate() - (day.getHours() < 2 ? 2 : 1));
    day.setHours(12, 0, 0, 0);
    return localDateKey(day);
  }

  function diaryWindow(date: string): { startAt: number; endAt: number } {
    const [year, month, day] = date.split("-").map(Number);
    return { startAt: new Date(year, month - 1, day, 4).getTime(),
      endAt: new Date(year, month - 1, day + 1, 2).getTime() };
  }

  async function writeDiary(): Promise<PlanningResult> {
    if (stopped || options?.stopSignal?.aborted || !state.settings.enabled || !state.planning.enabled
      || !options?.generate || !options.diaryPrompt) return result("refine", "skipped", "日记生成未启用");
    const at = now();
    if (!validTimestamp(at) || at < state.cursorAt) return result("refine", "skipped", "生活时钟无效或已倒退");
    advance();
    const date = completedDiaryDate(at);
    const { startAt, endAt } = diaryWindow(date);
    if (state.planning.diaryAttempts?.some((attempt) => attempt.date >= date))
      return result("refine", "skipped", "这一天的日记已经尝试生成");
    const dayMessages = options.dayMessages ? await options.dayMessages(startAt, endAt) : [];
    advance();
    if (state.planning.diaryAttempts?.some((attempt) => attempt.date >= date))
      return result("refine", "skipped", "这一天的日记已经尝试生成");
    const cutoff = new Date(`${date}T12:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - 13);
    const events = state.events.filter((event) => event.date === date && event.status !== "revoked"
      && event.endAt > startAt && event.endAt <= endAt)
      .sort((a, b) => a.endAt - b.endAt).slice(-24);
    const previousDay = new Date(startAt);
    previousDay.setDate(previousDay.getDate() - 1);
    const previousDate = localDateKey(previousDay);
    const actualEvents = state.events.filter((event) => event.status === "materialized"
      && event.source === "runtime_schedule" && event.endAt <= endAt);
    const recentSchedules: LifeDiarySchedule[] = [date, previousDate].map((day) => ({ date: day,
      events: actualEvents.filter((event) => event.date === day).sort((a, b) => a.startAt - b.startAt)
        .map(({ id, text, startAt, endAt, modelDetail }) => ({ id, text, startAt, endAt,
          status: "materialized" as const, source: "runtime_schedule" as const,
          ...(modelDetail ? { modelDetail } : {}) })) }));
    const relevanceQuery = [
      ...dayMessages.slice(-8).map((message) => message.content.slice(0, 80)),
      ...events.map((event) => `${event.text} ${event.modelDetail ?? ""}`),
    ].join(" ");
    const changes = (state.planning.conversationChanges ?? []).filter((change) => change.date === date
      && change.appliedAt >= startAt && change.appliedAt < endAt);
    const messageIds = new Set(dayMessages.filter((message) => message.role === "model").map((message) => message.id));
    const annotatedMessages = dayMessages.map((message) => {
      const scheduleChanges = message.role === "model" && message.id
        ? changes.filter((change) => change.messageId === message.id) : [];
      return scheduleChanges.length ? { ...message, scheduleChanges } : message;
    });
    if (!events.some((event) => event.status === "materialized" && event.source === "runtime_schedule")
      && dayMessages.length === 0)
      return result("refine", "skipped", "这一天没有可记录的生活事件或聊天消息");
    const controller = new AbortController();
    const signal = options.stopSignal ? AbortSignal.any([controller.signal, options.stopSignal]) : controller.signal;
    save({ ...state, planning: { ...state.planning, diaryAttempts: [
      ...(state.planning.diaryAttempts ?? []).filter((attempt) => attempt.date >= cutoff.toISOString().slice(0, 10)),
      { date, requestedAt: at, status: "reserved" },
    ] } });
    diaryController = controller;
    const input: LifeDiaryInput = { date, revision: state.revision, startAt, endAt,
      events: events.map(({ id, text, source, status, modelDetail }) => ({ id, text, source, status, modelDetail })),
      dayMessages: annotatedMessages, recentSchedules,
      recalledSchedules: indexedDiaries(at).recallEvents(relevanceQuery, previousDate),
      unmatchedChanges: changes.filter((change) => !change.messageId || !messageIds.has(change.messageId)),
      ...diaryReferences(date, relevanceQuery, at) };
    const finish = (status: Exclude<PlanningStatus, "skipped">, message: string, output?: ReturnType<typeof parseLifeDiary>): PlanningResult => {
      const outcome = result("refine", status, message);
      if (stopped || options?.stopSignal?.aborted) return outcome;
      const attempt = state.planning.diaryAttempts?.find((item) => item.date === date);
      if (!attempt || attempt.status !== "reserved") return outcome;
      const base = outcome.at > state.cursorAt && state.settings.enabled
        ? reconcileJournal(advanceContinuity(state, outcome.at, runtimeBoundary(outcome.at))) : state;
      const journal = output ? applyModelDiary(base.journal, output.date, output.summary,
        output.eventIds, base.events, base.cursorAt, state.revision + 1, endAt) : base.journal;
      const details = new Map(output?.details.map((item) => [item.eventId, item.text]) ?? []);
      const updatedEvents = details.size ? base.events.map((event) => details.has(event.id) && event.status === "materialized"
        && event.source === "runtime_schedule" && !event.modelDetail
        ? { ...event, modelDetail: details.get(event.id) } : event) : base.events;
      save({ ...base, events: updatedEvents, journal, planning: { ...base.planning, lastResult: outcome,
        diaryAttempts: base.planning.diaryAttempts?.map((item) => item.date === date ? { ...item, status } : item) } });
      observeRuntime(base.cursorAt);
      return outcome;
    };
    try {
      if (signal.aborted) return finish("cancelled", "日记生成已取消");
      const raw = await options.generate(buildLifeDiaryMessages(input, options.diaryPrompt), signal);
      if (signal.aborted || stopped || !state.settings.enabled || !state.planning.enabled)
        return finish("cancelled", "日记生成已取消");
      const completedAt = now();
      if (!validTimestamp(completedAt) || completedAt < at || state.revision !== input.revision
        || completedDiaryDate(completedAt) !== date)
        return finish("stale", "生活记录已变化，保留原有日记");
      let output: ReturnType<typeof parseLifeDiary>;
      try { output = parseLifeDiary(raw, input); }
      catch { return finish("invalid", "模型日记未通过校验，保留原有日记"); }
      return finish("applied", "完整日记已更新", output);
    } catch {
      return finish(signal.aborted ? "cancelled" : "failed", signal.aborted ? "日记生成已取消" : "日记模型请求失败");
    } finally {
      if (diaryController === controller) diaryController = undefined;
    }
  }

  function ensureDiary(): Promise<PlanningResult> {
    if (currentDiary) return currentDiary;
    const promise = writeDiary();
    currentDiary = promise;
    void promise.finally(() => { if (currentDiary === promise) currentDiary = undefined; }).catch(() => {});
    return promise;
  }

  async function planAutomatically(): Promise<void> {
    if (stopped || !state.settings.enabled || !state.planning.enabled) return;
    try { await ensureDiary(); } catch { /* 日记持久化失败不阻止早晨规划 */ }
    if (currentPlanning) return;
    const at = now(), date = localDateKey(new Date(at));
    const attempts = state.planning.attempts.filter((attempt) => attempt.date === date);
    const hour = new Date(at).getHours(), minute = new Date(at).getMinutes();
    const phase = hour >= 6 && (hour > 6 || minute >= 45) && hour < 12 ? "morning" : undefined;
    if (phase && !attempts.some((attempt) => attempt.phase === phase)) await plan("daily");
  }

  function stop(): void {
    stopped = true;
    conversationOffers.clear();
    currentPlanning?.controller.abort();
    diaryController?.abort();
    if (timer) clearInterval(timer);
    timer = undefined;
    options?.stopSignal?.removeEventListener("abort", stop);
  }
  if (options?.stopSignal?.aborted) stopped = true;
  else options?.stopSignal?.addEventListener("abort", stop, { once: true });

  return {
    start() {
      if (timer || stopped) return;
      advance();
      void planAutomatically().catch(() => {});
      timer = setInterval(() => {
        try { advance(); void planAutomatically().catch(() => {}); }
        catch (error) {
          stop();
          console.warn("[Life] 生活推进失败，已停止写入:", error instanceof Error ? error.message : String(error));
        }
      }, CURSOR_CHECKPOINT_MS);
      timer.unref?.();
    },
    stop,
    async awaitPendingDiary() {
      try { await ensureDiary(); } catch { /* 保留原日记，继续处理用户请求 */ }
    },
    writeDiary: ensureDiary,
    view,
    getShareCandidate(): LifeShareSource | null {
      return canShare() ? getLifeShareCandidate(state.events, state.sharing, now()) : null;
    },
    isShareEligible,
    reserveShare(source: LifeShareSource): boolean {
      const at = now();
      if (stopped || !state.settings.enabled || !validTimestamp(at) || at < state.cursorAt) return false;
      const next = reconcileJournal(advanceContinuity(state, at, runtimeBoundary(at)));
      if (next.self.resting || !isLifeShareEligible(source, next.events, next.sharing, at)) return false;
      save({ ...next, sharing: reserveLifeShare(next.sharing, source, at) });
      observeRuntime(at);
      return true;
    },
    completeShare(source: LifeShareSource, receipt: LifeShareReceipt): void {
      if (stopped) return;
      const sharing = completeLifeShare(state.sharing, source, receipt);
      if (sharing !== state.sharing) save({ ...state, sharing });
    },
    configure(enabled: unknown, importantDatesText: unknown) {
      if (stopped) throw new Error("生活系统已停止，拒绝写入");
      if (typeof enabled !== "boolean") throw new Error("生活日程设置无效");
      const settings: LifeContextSettings = { version: 1, enabled, importantDates: parseImportantDates(importantDatesText).map((item) => {
        const previous = state.settings.importantDates.find((saved) => saved.date === item.date && saved.label === item.label);
        return previous?.remind === undefined ? item : { ...item, remind: previous.remind };
      }) };
      const at = now();
      if (!validTimestamp(at)) throw new Error("生活时钟无效");
      const changedEnabled = enabled !== state.settings.enabled;
      if (!enabled) { currentPlanning?.controller.abort(); diaryController?.abort(); }
      if (!persisted || changedEnabled || formatImportantDates(settings.importantDates) !== formatImportantDates(state.settings.importantDates)) {
        const advanced = changedEnabled && state.settings.enabled ? advanceContinuity(state, at, runtimeBoundary(at)) : state;
        const cursorAt = changedEnabled ? Math.max(advanced.cursorAt, at) : advanced.cursorAt;
        const resetAt = Math.floor(cursorAt / LIFE_MINUTE_MS) * LIFE_MINUTE_MS;
        const reset = { ...advanced.self, updatedAt: resetAt, activitySince: resetAt, activity: null, resting: true };
        const self = changedEnabled ? enabled ? advanceDynamics(reset, cursorAt, (activityAt) => plannedActivity(advanced, activityAt)).state : reset : advanced.self;
        save(reconcileJournal({ ...advanced, settings, cursorAt, self, pendingSegments: changedEnabled ? [] : advanced.pendingSegments,
          recordAfterAt: changedEnabled ? cursorAt : advanced.recordAfterAt }));
        if (changedEnabled) { runtimeStartedAt = undefined; lastObservedAt = undefined; }
      }
      if (changedEnabled && enabled) observeRuntime(at);
      return view();
    },
    configurePlanning(enabled: boolean) {
      if (stopped) throw new Error("生活系统已停止，拒绝写入");
      if (typeof enabled !== "boolean") throw new Error("生活规划设置无效");
      if (enabled !== state.planning.enabled) {
        currentPlanning?.controller.abort();
        diaryController?.abort();
        save({ ...state, planning: { ...state.planning, enabled } });
      }
      return view();
    },
    plan,
    cancelPlanning() {
      currentPlanning?.controller.abort();
      diaryController?.abort();
      if (currentPlanning && !stopped) finishPlanning(currentPlanning.id, result(currentPlanning.kind, "cancelled", "生活规划已取消"));
      return view();
    },
    saveGoal(input: unknown) {
      const next = journalChangeState();
      const goals = saveLifeGoal(next.journal.goals, input, next.cursorAt, state.revision + 1, activityCatalog());
      save(reconcileJournal({ ...next, journal: { ...next.journal, goals } }));
      if (state.settings.enabled) observeRuntime(state.cursorAt);
      return view();
    },
    setGoalStatus(id: string, status: "active" | "paused" | "completed" | "cancelled") {
      const next = journalChangeState();
      const goals = setLifeGoalStatus(next.journal.goals, id, status, next.cursorAt, state.revision + 1);
      save(reconcileJournal({ ...next, journal: { ...next.journal, goals } }));
      if (state.settings.enabled) observeRuntime(state.cursorAt);
      return view();
    },
    rebuildDiary(date: string) {
      const next = journalChangeState();
      const journal = rebuildLifeDiary(next.journal, date, next.events, next.cursorAt, state.revision + 1);
      save({ ...next, journal });
      if (state.settings.enabled) observeRuntime(state.cursorAt);
      return view();
    },
    setImportantDateReminder(date: string, label: string, remind: boolean) {
      if (stopped) throw new Error("生活系统已停止，拒绝写入");
      if (typeof remind !== "boolean" || typeof date !== "string" || typeof label !== "string") throw new Error("重要日期提醒设置无效");
      const item = state.settings.importantDates.find((item) => item.date === date && item.label === label);
      if (!item) throw new Error("重要日期不存在");
      if ((item.remind !== false) !== remind) save({ ...state, settings: { ...state.settings,
        importantDates: state.settings.importantDates.map((item) => item.date === date && item.label === label ? { ...item, remind } : item) } });
      return view();
    },
    revokeEvent(id: string) {
      if (stopped) throw new Error("生活系统已停止，拒绝写入");
      const event = state.events.find((item) => item.id === id);
      if (!event) throw new Error("生活记录不存在");
      if (event.status !== "revoked") save(reconcileJournal({ ...state, events: state.events.map((item) => item.id === id
        ? { ...item, status: "revoked", revision: state.revision + 1, modelDetail: undefined } : item) }));
      return view();
    },
    applyConversationUpdate(runId: string, raw: string, messageId: string | null = null): boolean {
      const offer = conversationOffers.get(runId);
      conversationOffers.delete(runId);
      if (!offer || stopped || !state.settings.enabled || !state.planning.enabled || typeof raw !== "string" || raw.length > 4_000
        || messageId !== null && (typeof messageId !== "string" || !messageId)) return false;
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return false; }
      const proposal = value as { action?: unknown; planToken?: unknown; window?: unknown; intentions?: unknown };
      if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)
        || !["action,planToken,window", "action,intentions,planToken,window", "action,intentions,planToken"]
          .includes(Object.keys(proposal).sort().join())
        || !["revise", "intentions"].includes(proposal.action as string)
        || (proposal.action === "revise") !== Object.hasOwn(proposal, "window")
        || (proposal.action === "intentions" && !Object.hasOwn(proposal, "intentions"))
        || proposal.planToken !== offer.planToken) return false;
      const at = now();
      if (!validTimestamp(at) || at < state.cursorAt || planningDate(at, offer.timezoneOffsetMinutes) !== planningDate(offer.requestedAt, offer.timezoneOffsetMinutes)
        || new Date(at).getTimezoneOffset() !== offer.timezoneOffsetMinutes
        || state.planning.lastConversationUpdateAt !== null && at - state.planning.lastConversationUpdateAt < CONVERSATION_UPDATE_COOLDOWN_MS
        || lifePlanToken(state.planning) !== offer.planToken
        || JSON.stringify(state.journal.goals.map((goal) => [goal.id, goal.revision])) !== offer.goalToken) return false;
      let intentions: ModelLifeIntention[] | undefined;
      if (Object.hasOwn(proposal, "intentions")) {
        try { intentions = parseModelIntentions(proposal.intentions, planningDate(at, offer.timezoneOffsetMinutes), state.journal.goals); }
        catch { return false; }
      }
      const window = proposal.window as { id?: unknown; startAt?: unknown; endAt?: unknown; segments?: unknown } | undefined;
      const target = window && offer.windows.find((item) => item.id === window.id && item.startAt === window.startAt && item.endAt === window.endAt);
      if (proposal.action === "revise" && (!window || typeof window !== "object" || Array.isArray(window)
        || Object.keys(window).sort().join() !== "endAt,id,segments,startAt"
        || !target || at >= target.startAt || !Array.isArray(window.segments)
        || window.segments.length < 1 || window.segments.length > 4)) return false;
      const segments = (window?.segments ?? []) as Array<{ activity?: unknown; minutes?: unknown; goalRef?: unknown }>;
      const allowed = new Set(state.journal.goals.filter((goal) => goal.status === "active" && goal.source === "user").map((goal) => goal.id));
      if (intentions) intentions.forEach((item, index) => allowed.add(item.id ?? `new:${index}`));
      else state.journal.goals.filter((goal) => goal.status === "active" && goal.source === "model")
        .forEach((goal) => allowed.add(goal.id));
      if (target && (segments.some((segment) => !segment || typeof segment !== "object" || Array.isArray(segment)
        || !["activity,minutes", "activity,goalRef,minutes"].includes(Object.keys(segment).sort().join())
        || !validLifeActivity(segment.activity)
        || (Object.hasOwn(segment, "goalRef") && segment.goalRef !== null
          && (typeof segment.goalRef !== "string" || !allowed.has(segment.goalRef)))
        || !Number.isSafeInteger(segment.minutes) || (segment.minutes as number) < 30 || (segment.minutes as number) % 15 !== 0)
        || segments.reduce((sum, segment) => sum + (segment.minutes as number), 0) !== (target.endAt - target.startAt) / 60_000)) return false;
      const base = reconcileJournal(advanceContinuity(state, at, runtimeBoundary(at)));
      const applied = intentions ? applyModelIntentions(base.journal.goals, intentions, at, state.revision + 1) : undefined;
      const refs = segments.map((segment) => segment.goalRef as string | null | undefined ?? null);
      const plan: ConversationLifePlan | undefined = target ? { ...target,
        activities: segments.map((segment) => segment.activity as string),
        durations: segments.map((segment) => segment.minutes as number),
        ...(refs.some(Boolean) ? { goalRefs: refs.map((id) => id?.startsWith("new:")
          ? applied!.ids[Number(id.slice(4))] : id) } : {}),
        requestedAt: offer.requestedAt, appliedAt: at, timezoneOffsetMinutes: offer.timezoneOffsetMinutes,
        revision: state.revision + 1, runId } : undefined;
      const change: LifeDiaryChange = { runId, messageId, date: planningDate(at, offer.timezoneOffsetMinutes),
        appliedAt: at, revision: state.revision + 1,
        ...(plan ? { window: { id: plan.id, startAt: plan.startAt, endAt: plan.endAt,
          before: plannedWindowSegments(base, plan),
          after: plan.activities.map((activity, index) => ({ activity, minutes: plan.durations[index],
            goalRef: plan.goalRefs?.[index] ?? null })) } } : {}),
        ...(applied ? { intentions: { before: modelIntentionSnapshot(base.journal),
          after: modelIntentionSnapshot({ ...base.journal, goals: applied.goals }) } } : {}) };
      save({ ...base, journal: applied ? { ...base.journal, goals: applied.goals } : base.journal,
        planning: { ...base.planning, lastConversationUpdateAt: at,
          conversationPlans: plan ? [...base.planning.conversationPlans, plan] : base.planning.conversationPlans,
          conversationChanges: [...(base.planning.conversationChanges ?? []).slice(-9_999), change] } });
      observeRuntime(at);
      return true;
    },
    discardConversationUpdate(runId: string): void { conversationOffers.delete(runId); },
    searchDiary(query: string, limit = 5): LifeDiarySearchHit[] {
      if (stopped) return [];
      advance();
      return indexedDiaries(now()).search(query, limit);
    },
    build: (query = "", contextOptions: { proactive?: boolean; conversationRunId?: string;
      recentMessages?: Array<{ role: "user" | "model"; content: string }> } = {}) => {
      if (!state.settings.enabled) return "";
      advance();
      const at = now();
      let offer: ConversationLifeOffer | undefined;
      if (contextOptions.conversationRunId && state.planning.enabled && validTimestamp(at)
        && at >= state.cursorAt && new Date(at).getHours() >= 6 && new Date(at).getHours() < 23
        && (state.planning.lastConversationUpdateAt === null
          || at - state.planning.lastConversationUpdateAt >= CONVERSATION_UPDATE_COOLDOWN_MS)) {
        const timezoneOffsetMinutes = new Date(at).getTimezoneOffset();
        const windows = planningWindows("refine", at, timezoneOffsetMinutes, true);
        for (const [runId, previous] of conversationOffers) {
          if (at - previous.requestedAt > 60 * 60_000) conversationOffers.delete(runId);
        }
        if (conversationOffers.size >= 64) conversationOffers.delete(conversationOffers.keys().next().value!);
        offer = { requestedAt: at, timezoneOffsetMinutes, windows, planToken: lifePlanToken(state.planning),
          goalToken: JSON.stringify(state.journal.goals.map((goal) => [goal.id, goal.revision])) };
        conversationOffers.set(contextOptions.conversationRunId, offer);
      }
      const diaryHits = !contextOptions.proactive && /以前|之前|哪次|哪天|哪本|读过|遇到|碰到|回忆/.test(query)
        ? indexedDiaries(at).search(query, 3) : [];
      const diaryMemory = offer ? diaryReferences(localDateKey(new Date(at)), [
        query.slice(0, 120), ...(contextOptions.recentMessages ?? []).slice(-2).map((message) => message.content.slice(0, 120)),
        ...state.journal.goals.filter((goal) => goal.status === "active").slice(0, 3)
          .map((goal) => `${goal.title} ${goal.activity}`.slice(0, 80)),
      ].join(" "), at) : undefined;
      return buildContext(new Date(at), state.settings.importantDates, state.events, state.self, state.planning,
        state.journal, query, contextOptions.proactive, offer, contextOptions.recentMessages, diaryHits, diaryMemory);
    },
    status: (): LifeStatus | null => {
      if (!state.settings.enabled) return null;
      advance();
      return formatLifeStatus(state.self.activity, state.self.resting);
    },
  };
}
