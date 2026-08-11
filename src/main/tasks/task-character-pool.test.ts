import { describe, expect, it } from "vitest";
import { TaskCharacterLeasePool } from "./task-character-pool";

describe("TaskCharacterLeasePool", () => {
  it("uses the fixed weight boundaries before renormalization", () => {
    const pool = new TaskCharacterLeasePool();
    expect(pool.acquire("chat-a", () => 0).nickname).toBe("风堇");
    expect(pool.acquire("chat-b", () => 0.149).nickname).toBe("风堇");
    expect(pool.acquire("chat-c", () => 0.15).nickname).toBe("刻律德菈");
  });

  it("removes active names and renormalizes all remaining weights by the same denominator", () => {
    const pool = new TaskCharacterLeasePool();
    const first = pool.acquire("chat-a", () => 0);
    const second = pool.acquire("chat-a", () => 0);

    expect(first.nickname).toBe("风堇");
    expect(second.nickname).toBe("刻律德菈");

    first.release();
    expect(pool.acquire("chat-a", () => 0).nickname).toBe("风堇");
  });

  it("releases a lease idempotently and never duplicates any of twelve active names", () => {
    const pool = new TaskCharacterLeasePool();
    const leases = Array.from({ length: 12 }, () => pool.acquire("chat-a", () => 0));
    expect(new Set(leases.map((lease) => lease.nickname))).toHaveLength(12);
    expect(() => pool.acquire("chat-a", () => 0)).toThrow("TASK_CHARACTER_POOL_EXHAUSTED");
    leases[0].release();
    leases[0].release();
    expect(pool.acquire("chat-a", () => 0).nickname).toBe("风堇");
  });
});
