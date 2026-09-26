import { describe, expect, it } from "vitest";
import type { LifeEvent } from "../plugins/companion-chat/src/life-context";
import { completeLifeShare, getLifeShareCandidate, isLifeShareEligible, reserveLifeShare, validateSharing,
  type LifeShareRecord, type LifeSharingState } from "../plugins/companion-chat/src/life-sharing";

const hour = 60 * 60_000, at = new Date(2026, 8, 1, 13).getTime();
const event = (id: string, endAt = at - hour, extra: Partial<LifeEvent> = {}): LifeEvent => ({
  id, date: "2026-09-01", text: "上午：读书", startAt: endAt - hour, endAt,
  source: "runtime_schedule", status: "materialized", revision: 1, worldLayer: "simulated_world", ...extra,
});
const receipt = { conversationId: "simulation-conversation", messageId: "simulation-message", at: new Date(at).toISOString() };

describe("生活分享纯状态", () => {
  it("只选最近有效的运行事件，旧版、推演、撤销、未来和过期事件都不候选", () => {
    const events = [event("old", at - 2 * hour), event("latest"),
      event("legacy", at, { source: "legacy_schedule" }), event("inferred", at, { source: "offline_inference", status: "inferred" }),
      event("revoked", at, { status: "revoked" }), event("future", at + 1), event("expired", at - 24 * hour)];
    const source = getLifeShareCandidate(events, { records: [] }, at)!;
    expect(source).toMatchObject({ eventId: "latest", expiresAt: at + 23 * hour });
    source.text = "调用方修改副本";
    expect(events[1].text).toBe("上午：读书");
    expect(getLifeShareCandidate(events.slice(2), { records: [] }, at)).toBeNull();
  });

  it("冻结来源每个字段都匹配且一次预留后永不重新成为候选", () => {
    const events = [event("one")], empty = { records: [] };
    const source = getLifeShareCandidate(events, empty, at)!;
    expect(isLifeShareEligible(source, events, empty, at)).toBe(true);
    for (const changed of [{ eventRevision: 2 }, { text: "另外的活动" }, { startAt: source.startAt + 1 }, { expiresAt: source.expiresAt + 1 }]) {
      expect(isLifeShareEligible({ ...source, ...changed }, events, empty, at)).toBe(false);
    }
    const pending = reserveLifeShare(empty, source, at);
    expect(isLifeShareEligible(source, events, pending, at)).toBe(false);
    expect(getLifeShareCandidate(events, pending, at)).toBeNull();
    expect(reserveLifeShare(pending, source, at)).toBe(pending);
    expect(completeLifeShare(pending, source, receipt).records[0]).toMatchObject({ status: "delivered", receipt });
  });

  it("已投递来源撤销后仍可加载历史回执，坏引用与重复记录拒绝覆盖", () => {
    const original = event("one");
    const source = getLifeShareCandidate([original], { records: [] }, at)!;
    const delivered = completeLifeShare(reserveLifeShare({ records: [] }, source, at), source, receipt);
    const revoked = { ...original, status: "revoked" as const, revision: 3 };
    expect(validateSharing(delivered, [revoked], at)).toEqual(delivered);
    expect(() => validateSharing(delivered, [], at)).toThrow("损坏");
    expect(() => validateSharing({ records: [...delivered.records, ...delivered.records] }, [revoked], at)).toThrow("损坏");
    expect(() => validateSharing({ records: [{ ...delivered.records[0], eventRevision: 3 }] }, [revoked], at)).toThrow("损坏");
    expect(() => validateSharing({ records: [{ ...delivered.records[0], receipt: null }] }, [revoked], at)).toThrow("损坏");
  });

  it("历史裁剪保持所有未过期预留，超出上限只去掉最早过期记录", () => {
    const records: LifeShareRecord[] = Array.from({ length: 510 }, (_, index) => ({
      eventId: `past:${index}`, eventRevision: 1, text: "已过期记录", startAt: at - 50 * hour,
      endAt: at - 49 * hour, expiresAt: at - 25 * hour, reservedAt: at - 48 * hour + index, status: "pending", receipt: null,
    }));
    const events = [event("current1"), event("current2"), event("new")];
    let sharing: LifeSharingState = { records };
    for (const item of events) sharing = reserveLifeShare(sharing, getLifeShareCandidate([item], { records: [] }, at)!, at);
    expect(sharing.records).toHaveLength(500);
    expect(sharing.records.some((item) => item.eventId === "past:0")).toBe(false);
    for (const item of events) expect(sharing.records.some((record) => record.eventId === item.id)).toBe(true);
  });
});
