import { describe, expect, it } from "vitest";
import { createStartupReadiness } from "./readiness";

describe("createStartupReadiness", () => {
  it("keeps lifecycle phase independent from degraded capabilities", () => {
    const readiness = createStartupReadiness({ now: () => 10 });
    readiness.transition("shell-ready");
    readiness.markDegraded({ capability: "rag", message: "offline", at: 10 });
    readiness.transition("core-ready");
    expect(readiness.getPhase()).toBe("core-ready");
    expect(readiness.getDegradedReasons().has("rag")).toBe(true);
    readiness.clearDegraded("rag");
    expect(readiness.getPhase()).toBe("core-ready");
  });

  it("rejects core waiters when startup fails", async () => {
    const readiness = createStartupReadiness();
    const waiting = readiness.waitFor("core-ready");
    readiness.transition("failed");
    await expect(waiting).rejects.toThrow("startup failed");
  });

  it("rejects invalid phase transitions", () => {
    const readiness = createStartupReadiness();
    expect(() => readiness.transition("ready")).toThrow("preparing");
    expect(readiness.getPhase()).toBe("preparing");
  });

  it("resolves waiters when the requested phase is reached", async () => {
    const readiness = createStartupReadiness();
    const waiting = readiness.waitFor("core-ready");
    readiness.transition("shell-ready");
    readiness.transition("core-ready");
    await expect(waiting).resolves.toBeUndefined();
  });

  it("resolves late waiters whose target phase was already reached", async () => {
    const readiness = createStartupReadiness();
    readiness.transition("shell-ready");
    readiness.transition("core-ready");
    await expect(readiness.waitFor("core-ready")).resolves.toBeUndefined();
  });

  it("rejects waiters once shutdown starts", async () => {
    const readiness = createStartupReadiness();
    const waiting = readiness.waitFor("ready");
    readiness.transition("stopping");
    await expect(waiting).rejects.toThrow("stopping");
  });

  it("rejects waiters through an aborted signal", async () => {
    const readiness = createStartupReadiness();
    const controller = new AbortController();
    const waiting = readiness.waitFor("ready", controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/abort/i);
  });
});
