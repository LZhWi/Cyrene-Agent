import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planLegacyRuntimeIncremental, type RuntimeSnapshot } from "../plugins/companion-memory/src/legacy-runtime-incremental";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const entries = [{ id: "a", content: "A" }, { id: "b", content: "B" }];
function fixture(): RuntimeSnapshot {
  return { dmae: { version: 1, round: 1, states: {} }, lifecycle: { version: 1, revision: 0, recalls: { a: { lastHitAt: 1, hitCount: 1, weight: 10 } }, lastDecayAt: 1 },
    inbox: { version: 1, revision: 0, items: [{ id: "old", key: "a\u0000b", leftId: "a", rightId: "b", kind: "conflict", leftHash: hash("A"), rightHash: hash("B"), createdAt: 1, status: "open" }] } };
}
describe("runtime three-way migration", () => {
  it("replaces the whole test DMAE timeline only when explicitly selected", () => {
    const baseline = fixture(), current = fixture(), incoming = fixture();
    current.dmae.round = 3; incoming.dmae.round = 10;
    const plan = planLegacyRuntimeIncremental(baseline, current, incoming, entries, { replaceTestDmae: true });
    expect(plan.next.dmae).toEqual(incoming.dmae);
    expect(plan.baseline.dmae).toEqual(incoming.dmae);
    expect(plan.conflicts).toEqual([]);
  });
  it("updates untouched state, survives replay and leaves inputs unchanged", () => {
    const baseline = fixture(), incoming = fixture(); incoming.dmae.round = 2;
    incoming.lifecycle.recalls.a.hitCount = 2; incoming.lifecycle.lastDecayAt = 2;
    incoming.inbox.items[0].status = "dismissed";
    const plan = planLegacyRuntimeIncremental(baseline, baseline, incoming, entries);
    expect(plan.conflicts).toEqual([]); expect(plan.next.dmae.round).toBe(2);
    expect(plan.next.lifecycle.recalls.a.hitCount).toBe(2); expect(plan.next.inbox.items[0].status).toBe("dismissed");
    expect(baseline).toEqual(fixture());
    expect(planLegacyRuntimeIncremental(plan.baseline, plan.next, incoming, entries).changes).toEqual([]);
  });
  it("preserves independent clocks, local statistics, decisions and deletions", () => {
    const baseline = fixture(), current = fixture(), incoming = fixture();
    current.dmae.round = 3; incoming.dmae.round = 2;
    current.lifecycle.recalls.a.hitCount = 4; incoming.lifecycle.recalls.a.hitCount = 2;
    current.inbox.items[0].status = "dismissed"; incoming.inbox.items[0].reason = "new reason";
    const plan = planLegacyRuntimeIncremental(baseline, current, incoming, entries);
    expect(plan.next).toEqual(current); expect(plan.conflicts).toHaveLength(3);
    expect(planLegacyRuntimeIncremental(plan.baseline, plan.next, incoming, entries).conflicts).toEqual(plan.conflicts);
    delete current.lifecycle.recalls.a; current.inbox.items = [];
    expect(planLegacyRuntimeIncremental(baseline, current, incoming, entries).next).toEqual(current);
  });
  it("does not call target-only changes conflicts and rejects stale evidence", () => {
    const baseline = fixture(), current = fixture(); current.dmae.round = 2;
    expect(planLegacyRuntimeIncremental(baseline, current, baseline, entries).conflicts).toEqual([]);
    const incoming = fixture(); incoming.inbox.items[0].reason = "changed";
    const plan = planLegacyRuntimeIncremental(baseline, baseline, incoming, [{ id: "a", content: "edited" }, entries[1]]);
    expect(plan.next.inbox).toEqual(baseline.inbox); expect(plan.conflicts[0]).toContain("stale-evidence");
  });
});
