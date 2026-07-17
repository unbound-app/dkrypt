import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { getSessionVersion, PERMISSION_KEYS, type Permissions } from './store/state.js';

const COOKIE_NAME = 'session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Session {
  sub: string;
  permissions: Permissions;
  exp: number;
  ver: number;
}

function isPermissions(value: unknown): value is Permissions {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return PERMISSION_KEYS.every((k) => typeof p[k] === 'boolean');
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
  const body = Buffer.from(JSON.stringify({ ...session, exp: expiresAtMs })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function deserialize(cookieValue: string): Session | undefined {
  const [body, sig] = cookieValue.split('.');
  if (!body || !sig) return undefined;
  if (!safeEqualStr(sig, sign(body))) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session;
    if (Date.now() > parsed.exp) return undefined;
    if (typeof parsed.sub !== 'string' || !isPermissions(parsed.permissions)) return undefined;
    // A version mismatch means "log out everywhere" fired since this cookie was issued.
    if ((parsed.ver ?? 0) !== getSessionVersion(parsed.sub)) return undefined;
    return { sub: parsed.sub, permissions: parsed.permissions, exp: parsed.exp, ver: parsed.ver ?? 0 };
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
  return value ? deserialize(value) : undefined;
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

export function requirePermission(...perms: (keyof Permissions)[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = getSession(req);
    if (!session) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    if (!perms.some((p) => session.permissions[p])) {
      res.status(403).json({ error: `requires one of these permissions: ${perms.join(', ')}` });
      return;
    }
    res.locals.session = session;
    next();
  };
}
