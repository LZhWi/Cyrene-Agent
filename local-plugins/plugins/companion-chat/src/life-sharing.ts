import type { LifeEvent } from "./life-context";

const SHARE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const RETAINED_SHARE_LIMIT = 500;

export interface LifeShareSource {
  eventId: string;
  eventRevision: number;
  text: string;
  startAt: number;
  endAt: number;
  expiresAt: number;
}

export interface LifeShareReceipt { conversationId: string; messageId: string; at: string }
export interface LifeShareRecord extends LifeShareSource {
  status: "pending" | "delivered";
  reservedAt: number;
  receipt: LifeShareReceipt | null;
}
export interface LifeSharingState { records: LifeShareRecord[] }

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function matchesEvent(source: LifeShareSource, event: LifeEvent, allowRevoked = false): boolean {
  return source.eventId === event.id && source.text === event.text && source.startAt === event.startAt && source.endAt === event.endAt
    && timestamp(source.expiresAt) && source.expiresAt === event.endAt + SHARE_LIFETIME_MS
    && Number.isSafeInteger(source.eventRevision) && source.eventRevision >= 0
    && event.source === "runtime_schedule"
    && (event.status === "materialized" && source.eventRevision === event.revision
      || allowRevoked && event.status === "revoked" && source.eventRevision < event.revision);
}

function sameSource(left: LifeShareSource, right: LifeShareSource): boolean {
  return left.eventId === right.eventId && left.eventRevision === right.eventRevision && left.text === right.text
    && left.startAt === right.startAt && left.endAt === right.endAt && left.expiresAt === right.expiresAt;
}

function validReceipt(value: unknown): value is LifeShareReceipt {
  const receipt = value as LifeShareReceipt;
  return Boolean(receipt && typeof receipt.conversationId === "string" && receipt.conversationId.trim()
    && typeof receipt.messageId === "string" && receipt.messageId.trim()
    && typeof receipt.at === "string" && timestamp(Date.parse(receipt.at)));
}

export function validateSharing(value: unknown, events: LifeEvent[], maxAt: number): LifeSharingState {
  if (value === undefined) return { records: [] };
  const sharing = value as LifeSharingState;
  const invalid = () => new Error("生活分享状态损坏，拒绝覆盖");
  if (!sharing || !Array.isArray(sharing.records) || sharing.records.length > 100_000) throw invalid();
  const seen = new Set<string>();
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const record of sharing.records) {
    const event = byId.get(record?.eventId);
    if (!record || !event || seen.has(record.eventId) || !matchesEvent(record, event, true)
      || !timestamp(record.reservedAt) || record.reservedAt < record.endAt || record.reservedAt >= record.expiresAt || record.reservedAt > maxAt
      || record.status !== "pending" && record.status !== "delivered"
      || (record.status === "pending" ? record.receipt !== null : !validReceipt(record.receipt))) throw invalid();
    seen.add(record.eventId);
  }
  return structuredClone(sharing);
}

export function isLifeShareEligible(source: LifeShareSource, events: LifeEvent[], sharing: LifeSharingState, at: number): boolean {
  if (!source || !timestamp(at) || source.endAt > at || source.expiresAt <= at || sharing.records.some((record) => record.eventId === source.eventId)) return false;
  const event = events.find((event) => event.id === source.eventId);
  return Boolean(event && matchesEvent(source, event));
}

export function getLifeShareCandidate(events: LifeEvent[], sharing: LifeSharingState, at: number): LifeShareSource | null {
  if (!timestamp(at)) return null;
  const reserved = new Set(sharing.records.map((record) => record.eventId));
  let latest: LifeEvent | undefined;
  for (const event of events) {
    if (event.source !== "runtime_schedule" || event.status !== "materialized" || event.endAt > at
      || event.endAt + SHARE_LIFETIME_MS <= at || !timestamp(event.endAt + SHARE_LIFETIME_MS) || reserved.has(event.id)) continue;
    if (!latest || event.endAt > latest.endAt || event.endAt === latest.endAt && (event.startAt > latest.startAt
      || event.startAt === latest.startAt && event.id.localeCompare(latest.id) < 0)) latest = event;
  }
  return latest ? { eventId: latest.id, eventRevision: latest.revision, text: latest.text,
    startAt: latest.startAt, endAt: latest.endAt, expiresAt: latest.endAt + SHARE_LIFETIME_MS } : null;
}

export function reserveLifeShare(sharing: LifeSharingState, source: LifeShareSource, at: number): LifeSharingState {
  if (sharing.records.some((record) => record.eventId === source.eventId)) return sharing;
  // 过期来源已不能再成为候选；保留所有未过期记录，并只裁剪更早的历史记录。
  const expired = sharing.records.filter((record) => record.expiresAt <= at).sort((left, right) => right.reservedAt - left.reservedAt);
  const current = sharing.records.filter((record) => record.expiresAt > at);
  const records = [...expired.slice(0, Math.max(0, RETAINED_SHARE_LIMIT - current.length - 1)), ...current];
  return { records: [...records, { ...structuredClone(source), status: "pending", reservedAt: at, receipt: null }] };
}

export function completeLifeShare(sharing: LifeSharingState, source: LifeShareSource, receipt: LifeShareReceipt): LifeSharingState {
  const record = sharing.records.find((record) => sameSource(record, source));
  if (!record || record.status !== "pending") return sharing;
  if (!validReceipt(receipt)) throw new Error("生活分享回执无效");
  return { records: sharing.records.map((item) => item === record ? { ...item, status: "delivered", receipt: structuredClone(receipt) } : item) };
}
