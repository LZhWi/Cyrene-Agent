import { describe, expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createLifeContext } from "../plugins/companion-chat/src/life-context";

const time = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();

function fixture() {
  let value: any, fail = false, at = time(1, 11, 30);
  const set = vi.fn((key: string, next: unknown) => {
    expect(key).toBe("life-state");
    if (fail) { fail = false; throw new Error("模拟原子写失败"); }
    value = structuredClone(next);
  });
  const storage: PluginStorage = { get: <T>(key: string) => (key === "life-state" ? structuredClone(value)
    : key === "life-context-settings" ? { version: 1, enabled: false, importantDates: [] } : undefined) as T | undefined,
    set, rootDir: () => "unused-memory-only" };
  const create = () => createLifeContext(storage, () => at);
  const life = create();
  life.configure(true, "");
  const warm = () => {
    life.build();
    at = time(1, 11, 45); life.build();
    at = time(1, 12); life.build();
    return life.getShareCandidate()!;
  };
  return { life, create, set, warm, at: (next: number) => { at = next; }, disk: () => structuredClone(value),
    failNext: () => { fail = true; }, receipt: () => ({ conversationId: "simulation-conversation", messageId: "simulation-message", at: new Date(at).toISOString() }) };
}

describe("生活分享原子预留与回执", () => {
  it("连续心跳产生可分享事件，重复读取不预留、不额外写入", () => {
    const f = fixture(), source = f.warm();
    expect(source.eventId).toBe("2026-09-01:上午");
    expect(f.life.view().continuity.events[0]).toMatchObject({ status: "materialized", source: "runtime_schedule" });
    const writes = f.set.mock.calls.length;
    expect(f.life.getShareCandidate()).toEqual(source);
    expect(f.life.isShareEligible(source)).toBe(true);
    expect(f.life.isShareEligible({ ...source, eventRevision: source.eventRevision + 1 })).toBe(false);
    expect(f.life.view().sharing.records).toEqual([]);
    expect(f.set).toHaveBeenCalledTimes(writes);
  });

  it("预留后重启仍然阻止重发，没有回执不能标记已投递", () => {
    const f = fixture(), source = f.warm();
    expect(f.life.reserveShare(source)).toBe(true);
    expect(f.life.reserveShare(source)).toBe(false);
    expect(f.life.view().sharing.records).toEqual([{ ...source, status: "pending", reservedAt: time(1, 12), receipt: null }]);
    f.life.stop();
    const restored = f.create();
    expect(restored.getShareCandidate()).toBeNull();
    expect(restored.isShareEligible(source)).toBe(false);
    expect(restored.reserveShare(source)).toBe(false);
    expect(() => restored.completeShare(source, null as any)).toThrow("回执无效");
    expect(restored.view().sharing.records[0].status).toBe("pending");
  });

  it("只有精确预留来源的真实回执进入已投递，撤销仍保留历史且可重载", () => {
    const f = fixture(), source = f.warm();
    f.life.completeShare(source, f.receipt());
    expect(f.life.view().sharing.records).toEqual([]);
    f.life.reserveShare(source);
    f.life.completeShare({ ...source, eventRevision: source.eventRevision + 1 }, f.receipt());
    expect(f.life.view().sharing.records[0].status).toBe("pending");
    f.life.completeShare(source, f.receipt());
    const delivered = f.life.view().sharing;
    expect(delivered.records[0]).toMatchObject({ status: "delivered", receipt: f.receipt() });
    const writes = f.set.mock.calls.length;
    f.life.completeShare(source, { ...f.receipt(), messageId: "other" });
    expect(f.set).toHaveBeenCalledTimes(writes);
    f.life.revokeEvent(source.eventId);
    expect(f.life.getShareCandidate()).toBeNull();
    expect(f.create().view().sharing).toEqual(delivered);
  });

  it("预留和完成写入失败都保留原状态，失败预留可重试但 pending 永不自动重试", () => {
    const f = fixture(), source = f.warm(), before = f.disk();
    f.failNext();
    expect(() => f.life.reserveShare(source)).toThrow("模拟原子写失败");
    expect(f.disk()).toEqual(before);
    expect(f.life.view().sharing.records).toEqual([]);
    expect(f.life.reserveShare(source)).toBe(true);
    const pending = f.disk();
    f.failNext();
    expect(() => f.life.completeShare(source, f.receipt())).toThrow("模拟原子写失败");
    expect(f.disk()).toEqual(pending);
    expect(f.life.view().sharing.records[0].status).toBe("pending");
    f.life.stop();
    expect(f.create().getShareCandidate()).toBeNull();
  });

  it("关闭、休息、过期、撤销和时间倒退都拒绝冻结候选", () => {
    for (const change of ["disabled", "rest", "expired", "revoked", "rollback"]) {
      const f = fixture(), source = f.warm();
      if (change === "disabled") f.life.configure(false, "");
      if (change === "rest") f.at(time(1, 23));
      if (change === "expired") f.at(time(2, 12));
      if (change === "revoked") f.life.revokeEvent(source.eventId);
      if (change === "rollback") f.at(time(1, 11, 59));
      expect(f.life.isShareEligible(source), change).toBe(false);
      expect(f.life.reserveShare(source), change).toBe(false);
      expect(f.life.getShareCandidate(), change).toBeNull();
    }
  });

  it("停止后迟到回执和读取均不写，pending 保留以避免不确定投递的重发", () => {
    const f = fixture(), source = f.warm();
    f.life.reserveShare(source); f.life.stop();
    const writes = f.set.mock.calls.length;
    f.at(time(2, 12));
    f.life.completeShare(source, f.receipt());
    expect(f.life.getShareCandidate()).toBeNull();
    expect(f.life.isShareEligible(source)).toBe(false);
    expect(f.life.reserveShare(source)).toBe(false);
    expect(f.life.view().sharing.records[0].status).toBe("pending");
    expect(f.set).toHaveBeenCalledTimes(writes);
  });

  it("同进程长停顿判为推演，提交失败后重试不会伪装成持续运行", () => {
    const f = fixture();
    f.life.build();
    f.at(time(1, 12, 1));
    const before = f.disk();
    f.failNext();
    expect(() => f.life.getShareCandidate()).toThrow("模拟原子写失败");
    expect(f.disk()).toEqual(before);
    expect(f.life.getShareCandidate()).toBeNull();
    expect(f.life.view().continuity.events[0]).toMatchObject({ source: "offline_inference", status: "inferred" });
  });

  it("停顿边界穿过的活动槽保守推演，之后完整连续运行的活动槽恢复运行来源", () => {
    const f = fixture();
    f.life.build(); f.at(time(1, 11, 45)); f.life.build();
    f.at(time(1, 12, 17)); f.life.build();
    for (let at = time(1, 12, 30); at <= time(1, 23); at += 15 * 60_000) { f.at(at); f.life.build(); }
    const events = f.life.view().continuity.events;
    expect(events.find((event) => event.id.endsWith("上午"))?.source).toBe("offline_inference");
    expect(events.find((event) => event.id.endsWith("下午"))?.source).toBe("offline_inference");
    expect(events.find((event) => event.id.endsWith("晚上"))?.source).toBe("runtime_schedule");
  });

  it("投递途中关闭或撤销只影响后续候选，真实迟到回执仍留档", () => {
    for (const change of ["disabled", "revoked"]) {
      const f = fixture(), source = f.warm();
      f.life.reserveShare(source);
      if (change === "disabled") f.life.configure(false, "");
      else f.life.revokeEvent(source.eventId);
      f.life.completeShare(source, f.receipt());
      expect(f.life.view().sharing.records[0]).toMatchObject({ status: "delivered", receipt: f.receipt() });
      expect(f.create().view().sharing).toEqual(f.life.view().sharing);
    }
  });

  it("关闭和目标修改结算也识别长停顿，不把未观察时段算成目标进展", () => {
    for (const action of ["disable", "goal"]) {
      const f = fixture();
      f.life.build(); f.at(time(1, 12, 1));
      if (action === "disable") f.life.configure(false, "");
      else f.life.saveGoal({ title: "下午的小目标", activity: "读书" });
      expect(f.life.view().continuity.events[0]).toMatchObject({ source: "offline_inference", status: "inferred" });
      expect(f.life.getShareCandidate()).toBeNull();
    }
  });
});
