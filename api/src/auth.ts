import type { NextFunction, Request, Response } from 'express';
import { isShareLinkExhausted, isShareLinkExpired, isShareLinkRevoked, recordShareLinkDownload, shareLinkExistsForToken, verifyApiKey } from '#store/state.js';
import { verifyTokenSignature } from '#util/signedUrl.js';

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
  next();
}

export function requireTestFlightScope(_req: Request, res: Response, next: NextFunction): void {
  if (res.locals.apiKeyAllowTestFlight === false) {
    res.status(403).json({ error: 'this API key is not scoped for TestFlight' });
    return;
  }
  next();
}

export function requireApiKeyOrSignedToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    const result = verifyApiKey(token, req.ip);
    if (result === 'rate-limited') {
      res.status(429).json({ error: 'this API key has hit its daily request limit' });
      return;
    }
    if (result) {
      res.locals.apiKeyScope = result.allowedBundleIds;
      res.locals.apiKeyOwner = result.ownerId;
      res.locals.apiKeyPriority = result.priority ?? 0;
      res.locals.apiKeyId = result.keyId;
      next();
      return;
    }
  }

  const queryToken = req.query.token;
  const jobId = req.params.id;
  if (typeof queryToken === 'string' && jobId) {
    const embeddedExpiresAtMs = verifyTokenSignature(jobId, queryToken);
    if (embeddedExpiresAtMs !== undefined) {
      if (shareLinkExistsForToken(jobId, queryToken)) {
        if (isShareLinkRevoked(jobId, queryToken)) {
          res.status(401).json({ error: 'this share link has been revoked' });
          return;
        }
        if (isShareLinkExpired(jobId, queryToken)) {
          res.status(401).json({ error: 'this share link has expired' });
          return;
        }
        if (isShareLinkExhausted(jobId, queryToken)) {
          res.status(410).json({ error: 'this share link has reached its download limit' });
          return;
        }
        recordShareLinkDownload(jobId, queryToken);
        next();
        return;
      }
      if (Date.now() <= embeddedExpiresAtMs) {
        next();
        return;
      }
    }
  }

  res.status(401).json({ error: 'unauthorized' });
}
