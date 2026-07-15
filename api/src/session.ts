import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import type { Role } from './store/state.js';

const COOKIE_NAME = 'session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Session {
  /** 'root' or a github username. */
  sub: string;
  role: Role;
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

function serialize(session: Session, expiresAtMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...session, exp: expiresAtMs })).toString('base64url');
  return `${body}.${sign(body)}`;
}

function deserialize(cookieValue: string): Session | undefined {
  const [body, sig] = cookieValue.split('.');
  if (!body || !sig) return undefined;
  if (!safeEqualStr(sig, sign(body))) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Session & { exp: number };
    if (Date.now() > parsed.exp) return undefined;
    return { sub: parsed.sub, role: parsed.role };
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

export function setSessionCookie(res: Response, session: Session): void {
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${serialize(session, expiresAtMs)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function getSession(req: Request): Session | undefined {
  const value = parseCookies(req)[COOKIE_NAME];
  return value ? deserialize(value) : undefined;
}

/** Any logged-in user, admin or member. */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.locals.session = session;
  next();
}

/** Admin-only actions: settings, user allowlist, key approval, Apple re-auth, etc. */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (session.role !== 'admin') {
    res.status(403).json({ error: 'admin role required' });
    return;
  }
  res.locals.session = session;
  next();
}
