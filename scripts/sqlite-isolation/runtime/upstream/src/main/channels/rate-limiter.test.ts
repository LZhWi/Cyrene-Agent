import { describe, expect, it } from "vitest";
import {
  createChannelRateLimiter,
  pruneExpiredRateLimitBuckets,
} from "./rate-limiter";

describe("ChannelRateLimiter", () => {
  it("渠道额度拒绝时不消费用户额度", () => {
    let now = 0;
    const limiter = createChannelRateLimiter({
      limits: { perUser: 2, perChannel: 2 },
      now: () => now,
    });

    expect(limiter.tryConsume("qq", "other-user-1")).toBe(true);
    now = 1;
    expect(limiter.tryConsume("qq", "other-user-2")).toBe(true);

    now = 59_000;
    expect(limiter.tryConsume("qq", "user-1")).toBe(false);

    now = 60_002;
    expect(limiter.tryConsume("qq", "user-1")).toBe(true);
    expect(limiter.tryConsume("qq", "user-1")).toBe(true);
  });

  it("清理全部过期桶并保留窗口内记录", () => {
    const buckets = new Map<string, number[]>([
      ["expired", [0]],
      ["mixed", [0, 30_001]],
      ["fresh", [30_002]],
    ]);

    pruneExpiredRateLimitBuckets(buckets, 60_001);

    expect(buckets).toEqual(new Map<string, number[]>([
      ["mixed", [30_001]],
      ["fresh", [30_002]],
    ]));
  });

  it("重新配置限额时清空旧桶", () => {
    const limiter = createChannelRateLimiter({
      limits: { perUser: 1, perChannel: 1 },
    });

    expect(limiter.tryConsume("qq", "user-1")).toBe(true);
    expect(limiter.tryConsume("qq", "user-1")).toBe(false);

    limiter.reconfigure({ perUser: 2, perChannel: 2 });

    expect(limiter.tryConsume("qq", "user-1")).toBe(true);
    expect(limiter.tryConsume("qq", "user-1")).toBe(true);
  });
});
