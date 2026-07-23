import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { hasAnyPermission, parseBits, serializeBits } from './permissions.js';
import { getSessionVersion, getUserEffectivePermissions } from './store/state.js';

const COOKIE_NAME = 'session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Session {
  sub: string;
  permissions: bigint;
  exp: number;
  ver: number;
}

interface SessionPayload {
  sub: string;
  permissions: string;
  exp: number;
  ver?: number;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return typeof p.sub === 'string' && typeof p.permissions === 'string' && typeof p.exp === 'number';
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sign(payload: string): string {
  return createHmac('sha256', config.downloadSigningSecret).update(payload).digest('hex');
}

function serialize(session: Omit<Session, 'exp'>, expiresAtMs: number): string {
  const payload: SessionPayload = { sub: session.sub, permissions: serializeBits(session.permissions), ver: session.ver, exp: expiresAtMs };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function deserialize(cookieValue: string): Session | undefined {
  const [body, sig] = cookieValue.split('.');
  if (!body || !sig) return undefined;
  if (!safeEqualStr(sig, sign(body))) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    if (!isSessionPayload(parsed)) return undefined;
    if (Date.now() > parsed.exp) return undefined;
    // A version mismatch means "log out everywhere" fired since this cookie was issued.
    if ((parsed.ver ?? 0) !== getSessionVersion(parsed.sub)) return undefined;
    return { sub: parsed.sub, permissions: parseBits(parsed.permissions), exp: parsed.exp, ver: parsed.ver ?? 0 };
  } catch {
    return undefined;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.header('cookie');
  if (!header) return {};

  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function checkRootPassword(candidate: string): boolean {
  return safeEqualStr(candidate, config.adminPassword);
}

export function setSessionCookie(res: Response, session: Omit<Session, 'exp' | 'ver'>): number {
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  const withVer: Omit<Session, 'exp'> = { ...session, ver: getSessionVersion(session.sub) };
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${serialize(withVer, expiresAtMs)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
  );
  return expiresAtMs;
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function getSession(req: Request): Session | undefined {
  const value = parseCookies(req)[COOKIE_NAME];
  const session = value ? deserialize(value) : undefined;
  if (!session || session.sub === 'root') return session;
  const permissions = getUserEffectivePermissions(session.sub);
  return permissions === undefined ? undefined : { ...session, permissions };
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.locals.session = session;
  next();
}

export function requirePermission(...flags: bigint[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!hasAnyPermission(session.permissions, flags)) {
      res.status(403).json({ error: 'you do not have permission to do that' });
      return;
    }
    res.locals.session = session;
    next();
  };
}
