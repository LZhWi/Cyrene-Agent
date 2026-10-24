import type { ChannelId } from "./types";

const WINDOW_MS = 60_000;

export interface ChannelRateLimits {
  perUser: number;
  perChannel: number;
}

export interface ChannelRateLimiter {
  tryConsume(channel: ChannelId, senderId: string): boolean;
  reconfigure(limits: ChannelRateLimits): void;
  reset(): void;
}

export interface CreateChannelRateLimiterOptions {
  limits: ChannelRateLimits;
  now?: () => number;
}

class InMemoryChannelRateLimiter implements ChannelRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private limits: ChannelRateLimits;

  constructor(
    options: CreateChannelRateLimiterOptions,
    private readonly now = options.now ?? Date.now,
  ) {
    this.limits = options.limits;
  }

  tryConsume(channel: ChannelId, senderId: string): boolean {
    const now = this.now();
    this.pruneExpired(now);

    const userKey = `${channel}:${senderId}`;
    const channelKey = `__channel__:${channel}`;
    const userBucket = this.buckets.get(userKey) ?? [];
    const channelBucket = this.buckets.get(channelKey) ?? [];

    if (userBucket.length >= this.limits.perUser
      || channelBucket.length >= this.limits.perChannel) {
      return false;
    }

    userBucket.push(now);
    channelBucket.push(now);
    this.buckets.set(userKey, userBucket);
    this.buckets.set(channelKey, channelBucket);
    return true;
  }

  reconfigure(limits: ChannelRateLimits): void {
    this.limits = limits;
    this.reset();
  }

  reset(): void {
    this.buckets.clear();
  }

  private pruneExpired(now: number): void {
    pruneExpiredRateLimitBuckets(this.buckets, now);
  }
}

export function pruneExpiredRateLimitBuckets(
  buckets: Map<string, number[]>,
  now: number,
): void {
  for (const [key, timestamps] of buckets) {
    const fresh = timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);
    if (fresh.length === 0) {
      buckets.delete(key);
    } else if (fresh.length !== timestamps.length) {
      buckets.set(key, fresh);
    }
  }
}

export function createChannelRateLimiter(
  options: CreateChannelRateLimiterOptions,
): ChannelRateLimiter {
  return new InMemoryChannelRateLimiter(options);
}
