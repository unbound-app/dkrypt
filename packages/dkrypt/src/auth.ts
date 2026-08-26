import type { NextFunction, Request, Response } from '#http.js';
import { recordApiKeyOutcome, verifyApiKey } from '#store/state.js';

function trackApiKeyOutcome(req: Request, res: Response, keyId: string | undefined): void {
  if (!keyId) return;
  res.raw.once('finish', () => recordApiKeyOutcome(keyId, req.method, req.path ?? req.url.split('?')[0], res.raw.statusCode));
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  const result = scheme === 'Bearer' && token ? verifyApiKey(token, req.ip) : undefined;
  if (result === 'rate-limited') {
    res.status(429).json({ error: 'this API key has hit its daily request limit' });
    return;
  }
  if (!result) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  res.locals.apiKeyScope = result.allowedBundleIds;
  res.locals.apiKeyOwner = result.ownerId;
  res.locals.apiKeyPriority = result.priority ?? 0;
  res.locals.apiKeyId = result.keyId;
  res.locals.apiKeyAllowTestFlight = result.allowTestFlight ?? true;
  trackApiKeyOutcome(req, res, result.keyId);
  next();
}

export function requireTestFlightScope(_req: Request, res: Response, next: NextFunction): void {
  if (res.locals.apiKeyAllowTestFlight === false) {
    res.status(403).json({ error: 'this API key is not scoped for TestFlight' });
    return;
  }
  next();
}
