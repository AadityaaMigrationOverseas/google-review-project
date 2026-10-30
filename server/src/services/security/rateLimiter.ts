import type { Clock } from '../../lib/clock.js';

export interface RateRule {
  limit: number;
  windowMs: number;
}

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * In-process fixed-window limiter. Suitable for a single instance; replace
 * with a shared store (e.g. Redis) when running several replicas.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly maxKeys = 50_000,
  ) {}

  consume(key: string, rule: RateRule): RateDecision {
    const now = this.clock.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      bucket = { count: 0, resetAt: now + rule.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    const allowed = bucket.count <= rule.limit;
    return {
      allowed,
      remaining: Math.max(0, rule.limit - bucket.count),
      retryAfterSec: allowed ? 0 : Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(now: number): void {
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    // Still full: drop the oldest entries rather than growing without bound.
    if (this.buckets.size >= this.maxKeys) {
      const excess = this.buckets.size - Math.floor(this.maxKeys * 0.9);
      let i = 0;
      for (const k of this.buckets.keys()) {
        if (i++ >= excess) break;
        this.buckets.delete(k);
      }
    }
  }
}

export const RATE_RULES = {
  shortLinkLookup: { limit: 60, windowMs: 60_000 },
  sentimentPreview: { limit: 120, windowMs: 60_000 },
  formToken: { limit: 30, windowMs: 10 * 60_000 },
  reviewSubmit: { limit: 5, windowMs: 10 * 60_000 },
  complaintSubmit: { limit: 3, windowMs: 10 * 60_000 },
  loginPerIp: { limit: 10, windowMs: 15 * 60_000 },
  adminApi: { limit: 300, windowMs: 60_000 },
} satisfies Record<string, RateRule>;
