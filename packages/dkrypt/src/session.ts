import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from '#http.js';
import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from 'fastify';
import { config } from '#config.js';
import { resolveAuthUserId } from '#identity.js';
import { mfaStatus } from '#mfa.js';
import { hasAnyPermission, parseBits, serializeBits } from '#permissions.js';
import { createSessionRecord, getSessionVersion, getUserEffectivePermissions, isSessionRecordActive } from '#store/state.js';

const COOKIE_NAME = 'session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const fastifySessionContext = new WeakMap<FastifyRequest, Session>();

export interface Session {
  sub: string;
  permissions: bigint;
  exp: number;
  ver: number;
  sid: string;
  mfaVerified?: boolean;
  reauthenticatedAt?: number;
}

interface SessionPayload {
  sub: string;
  permissions: string;
  exp: number;
  ver?: number;
  sid: string;
  mfaVerified?: boolean;
  reauthenticatedAt?: number;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return typeof p.sub === 'string' && typeof p.permissions === 'string' && typeof p.exp === 'number' && typeof p.sid === 'string';
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function sign(payload: string): string {
  return createHmac('sha256', config.sessionSigningSecret).update(payload).digest('hex');
}

function validSessionSignature(payload: string, signature: string): boolean {
  const candidates = [config.sessionSigningSecret, config.sessionSigningSecretPrevious].filter(Boolean);
  return candidates.some((secret) => safeEqualStr(signature, createHmac('sha256', secret).update(payload).digest('hex')));
}

function serialize(session: Omit<Session, 'exp'>, expiresAtMs: number): string {
  const payload: SessionPayload = { sub: session.sub, permissions: serializeBits(session.permissions), ver: session.ver, exp: expiresAtMs, sid: session.sid, mfaVerified: session.mfaVerified, reauthenticatedAt: session.reauthenticatedAt };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

function deserialize(cookieValue: string): Session | undefined {
  const [body, sig] = cookieValue.split('.');
  if (!body || !sig) return undefined;
  if (!validSessionSignature(body, sig)) return undefined;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    if (!isSessionPayload(parsed)) return undefined;
    if (Date.now() > parsed.exp) return undefined;
    const sub = parsed.sub === 'root' ? parsed.sub : resolveAuthUserId(parsed.sub);

    if ((parsed.ver ?? 0) !== getSessionVersion(sub)) return undefined;

    if (!isSessionRecordActive(parsed.sid)) return undefined;
    return { sub, permissions: parseBits(parsed.permissions), exp: parsed.exp, ver: parsed.ver ?? 0, sid: parsed.sid, mfaVerified: parsed.mfaVerified !== false, reauthenticatedAt: parsed.reauthenticatedAt };
  } catch {
    return undefined;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};

  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function sessionOptsFromReq(req: Request): { userAgent?: string; ip?: string } {
  return { userAgent: req.header('user-agent'), ip: req.ip };
}

export function checkRootPassword(candidate: string): boolean {
  return [config.adminPassword, config.adminPasswordPrevious].filter(Boolean).some((password) => safeEqualStr(candidate, password));
}

interface SessionCookieOpts {

  sid?: string;
  userAgent?: string;
  ip?: string;
}

export function setSessionCookie(res: Response, session: Omit<Session, 'exp' | 'ver' | 'sid'>, opts: SessionCookieOpts = {}): number {
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  const sid = opts.sid ?? createSessionRecord(session.sub, opts.userAgent, opts.ip).id;
  const withVer: Omit<Session, 'exp'> = { ...session, mfaVerified: session.mfaVerified !== false, ver: getSessionVersion(session.sub), sid };
  const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${serialize(withVer, expiresAtMs)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
  );
  return expiresAtMs;
}

export function requireRecentAuthentication(maxAgeMs = 10 * 60_000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = getSession(req);
    if (!session) {
      res.error('unauthorized', 'unauthorized', 401, false);
      return;
    }
    if (!session.reauthenticatedAt || Date.now() - session.reauthenticatedAt > maxAgeMs) {
      res.error('reauthentication_required', 'reauthentication is required for this action', 401, false);
      return;
    }
    res.locals.session = session;
    next();
  };
}

export function clearSessionCookie(res: Response): void {
  const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

export function getSession(req: Request): Session | undefined {
  return sessionFromCookieHeader(req.header('cookie'));
}

export function getFastifySession(request: FastifyRequest): Session | undefined {
  return fastifySessionContext.get(request) ?? sessionFromCookieHeader(request.headers.cookie);
}

function sessionFromCookieHeader(cookieHeader: string | undefined): Session | undefined {
  const value = parseCookies(cookieHeader)[COOKIE_NAME];
  const session = value ? deserialize(value) : undefined;
  if (!session || session.sub === 'root') return session;
  const sub = resolveAuthUserId(session.sub);
  const permissions = getUserEffectivePermissions(sub);
  return { ...session, sub, permissions };
}

function fastifySessionError(request: FastifyRequest, reply: FastifyReply, statusCode: number, code: string, message: string): void {
  reply.code(statusCode).send({ error: message, code, message, requestId: request.id, retryable: false });
}

function authorizeFastifySession(request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction, flags?: bigint[]): void {
  const session = sessionFromCookieHeader(request.headers.cookie);
  if (!session) {
    fastifySessionError(request, reply, 401, 'unauthorized', 'unauthorized');
    return;
  }
  if (!session.mfaVerified && mfaStatus(session.sub).enabled) {
    fastifySessionError(request, reply, 401, 'mfa_required', 'multi-factor authentication is required');
    return;
  }
  if (flags && !hasAnyPermission(session.permissions, flags)) {
    fastifySessionError(request, reply, 403, 'forbidden', 'you do not have permission to do that');
    return;
  }
  fastifySessionContext.set(request, session);
  done();
}

export function fastifyRequireSession(request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void {
  authorizeFastifySession(request, reply, done);
}

export function fastifyRequirePermission(...flags: bigint[]) {
  return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    authorizeFastifySession(request, reply, done, flags);
  };
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const session = getSession(req);
  if (!session) {
    res.error('unauthorized', 'unauthorized', 401, false);
    return;
  }
  if (!session.mfaVerified && mfaStatus(session.sub).enabled) {
    res.error('mfa_required', 'multi-factor authentication is required', 401, false);
    return;
  }
  res.locals.session = session;
  next();
}

export function requirePermission(...flags: bigint[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const session = getSession(req);
    if (!session) {
      res.error('unauthorized', 'unauthorized', 401, false);
      return;
    }
    if (!session.mfaVerified && mfaStatus(session.sub).enabled) {
      res.error('mfa_required', 'multi-factor authentication is required', 401, false);
      return;
    }
    if (!hasAnyPermission(session.permissions, flags)) {
      res.error('forbidden', 'you do not have permission to do that', 403, false);
      return;
    }
    res.locals.session = session;
    next();
  };
}
