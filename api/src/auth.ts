import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { verifyDownloadToken } from './util/signedUrl.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Requires a valid `Authorization: Bearer <API_KEY>` header. No exceptions - every route needs it. */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token || !safeEqual(token, config.apiKey)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  next();
}

/**
 * File downloads accept EITHER the master API key OR a short-lived signed
 * `?token=` scoped to that specific job. The signed token exists so the
 * GitHub Actions runner can fetch the IPA without embedding the master key
 * in a repository_dispatch payload.
 */
export function requireApiKeyOrSignedToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token && safeEqual(token, config.apiKey)) {
    next();
    return;
  }

  const queryToken = req.query.token;
  const jobId = req.params.id;
  if (typeof queryToken === 'string' && jobId && verifyDownloadToken(jobId, queryToken)) {
    next();
    return;
  }

  res.status(401).json({ error: 'unauthorized' });
}
