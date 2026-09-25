import type { NextFunction, Request, Response } from '#http.js';

interface Bucket {
  count: number;
  windowStartedAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(readonly maxRequests: number, readonly windowMs: number) {
    setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.windowStartedAt > this.windowMs) this.buckets.delete(key);
      }
    }, windowMs).unref();
  }

  consume(key: string, now = Date.now()): RateLimitDecision {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStartedAt > this.windowMs) {
      this.buckets.set(key, { count: 1, windowStartedAt: now });
      return { allowed: true, limit: this.maxRequests, remaining: Math.max(0, this.maxRequests - 1), resetAt: now + this.windowMs, retryAfterSeconds: 0 };
    }
    if (bucket.count >= this.maxRequests) {
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetAt: bucket.windowStartedAt + this.windowMs,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStartedAt + this.windowMs - now) / 1000)),
      };
    }
    bucket.count += 1;
    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - bucket.count),
      resetAt: bucket.windowStartedAt + this.windowMs,
      retryAfterSeconds: 0,
    };
  }
}

export function rateLimitPerUser(maxRequests: number, windowMs: number) {
  const limiter = new FixedWindowRateLimiter(maxRequests, windowMs);

  function setHeaders(res: Response, remaining: number, windowStartedAt: number): void {
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((windowStartedAt + windowMs) / 1000)));
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = res.locals.session?.sub ?? req.ip ?? 'unknown';
    const decision = limiter.consume(key);
    setHeaders(res, decision.remaining, decision.resetAt - windowMs);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.error('rate_limited', `too many requests - try again in ${decision.retryAfterSeconds}s`, 429, true);
      return;
    }
    next();
  };
}
