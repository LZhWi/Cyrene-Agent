import { randomUUID } from "node:crypto";
import { decide, parseObservation, type Decision, type Observation } from "./policy";

type Report = Decision & { id: string; actor: "companion"; observationId: string; source: Observation["source"]; status: "proposed" | "simulated-complete" | "simulated-failed" | "cancelled"; simulationOnly: true; gameInputSent: false; gameOutcomeVerified: false };
export class DecisionSession {
  private stopped = false;
  private pending?: Report;
  private reports: Report[] = [];
  private seen = new Set<string>();
  private latest = -1;
  private consumed = new Set<"heal" | "dodge">();
  status() { return structuredClone({ simulationOnly: true, gameInputSent: false, stopped: this.stopped, pending: this.pending, reports: this.reports }); }
  private cancel() { if (this.pending) this.pending.status = "cancelled"; this.pending = undefined; }
  private append(o: Observation, decision: Decision) {
    const report: Report = { ...decision, id: randomUUID(), actor: "companion", observationId: o.id, source: o.source, status: "proposed", simulationOnly: true, gameInputSent: false, gameOutcomeVerified: false };
    this.reports.push(report); if (this.reports.length > 30) this.reports.shift();
    if (!["wait", "release"].includes(report.action)) this.pending = report;
    return structuredClone(report);
  }
  preview(value: unknown, now = Date.now()) {
    let o: Observation;
    try { o = parseObservation(value); }
    catch (error) { this.cancel(); throw error; }
    if (this.stopped) return this.append(o, { action: "release", durationMs: 0, reason: "已手动停止，重置预演后才能继续" });
    if (!Number.isFinite(now) || o.capturedAt > now || now - o.capturedAt > 1500) {
      this.cancel(); return this.append(o, decide(o, now));
    }
    if (this.seen.has(o.id) || o.capturedAt <= this.latest) {
      this.cancel(); return this.append(o, { action: "release", durationMs: 0, reason: "重复或乱序观察，不重放旧动作" });
    }
    this.seen.add(o.id); if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
    this.latest = o.capturedAt;
    const decision = decide(o, now);
    if (decision.action === "release") this.cancel();
    else {
      if (o.self.potionReady === false) this.consumed.delete("heal");
      if (o.self.dodgeReady === false) this.consumed.delete("dodge");
      if (this.pending) {
        if (decision.action !== this.pending.action || JSON.stringify(decision.target) !== JSON.stringify(this.pending.target)) {
          this.cancel(); return this.append(o, { action: "release", durationMs: 0, reason: "新观察改变了行动条件，取消旧提案；等待下一次观察再规划" });
        }
        return this.append(o, { action: "wait", durationMs: 0, reason: "上一次提案尚未反馈，不叠加或补发动作" });
      }
    }
    if ((decision.action === "heal" || decision.action === "dodge") && this.consumed.has(decision.action)) return this.append(o, { action: "wait", durationMs: 0, reason: "模拟中已使用此能力，需要观察不可用再恢复可用，不能假定冷却已结束" });
    return this.append(o, decision);
  }
  feedback(id: unknown, status: unknown) {
    if (!this.pending || id !== this.pending.id) throw Error("只能反馈当前待确认提案，不能重放旧结果");
    if (status !== "simulated-complete" && status !== "simulated-failed") throw Error("此版仅接受模拟反馈");
    this.pending.status = status;
    if (status === "simulated-complete" && (this.pending.action === "heal" || this.pending.action === "dodge")) this.consumed.add(this.pending.action);
    this.pending = undefined; return this.status();
  }
  stop() { this.stopped = true; this.cancel(); return this.status(); }
  reset() { this.cancel(); this.stopped = false; this.seen.clear(); this.latest = -1; this.consumed.clear(); this.reports = []; return this.status(); }
}
