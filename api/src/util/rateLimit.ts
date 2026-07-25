import type { NextFunction, Request, Response } from 'express';

interface Bucket {
  count: number;
  windowStartedAt: number;
}

export function rateLimitPerUser(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, Bucket>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStartedAt > windowMs) buckets.delete(key);
    }
  }, windowMs).unref();

  function setHeaders(res: Response, remaining: number, windowStartedAt: number): void {
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((windowStartedAt + windowMs) / 1000)));
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = res.locals.session?.sub ?? req.ip ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStartedAt > windowMs) {
      buckets.set(key, { count: 1, windowStartedAt: now });
      setHeaders(res, maxRequests - 1, now);
      next();
      return;
    }

    if (bucket.count >= maxRequests) {
      const retryAfterS = Math.ceil((bucket.windowStartedAt + windowMs - now) / 1000);
      setHeaders(res, 0, bucket.windowStartedAt);
      res.setHeader('Retry-After', String(retryAfterS));
      res.status(429).json({ error: `too many requests - try again in ${retryAfterS}s` });
      return;
    }

    bucket.count += 1;
    setHeaders(res, maxRequests - bucket.count, bucket.windowStartedAt);
    next();
  };
}
