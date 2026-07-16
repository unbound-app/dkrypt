import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { config, githubOauthEnabled } from '../config.js';
import { log } from '../logger.js';
import { checkRootPassword, clearSessionCookie, getSession, requireSession, setSessionCookie } from '../session.js';
import { ADMIN_PERMISSIONS, getUserPermissions } from '../store/state.js';

export const authRouter = Router();

const LOCKOUT_AFTER = 5;
const MAX_LOCKOUT_MS = 5 * 60_000;
const FAILURE_WINDOW_MS = 15 * 60_000;

interface LoginAttempts {
  failures: number;
  lockedUntil: number;
  lastAttemptAt: number;
}

const loginAttempts = new Map<string, LoginAttempts>();

function loginLockoutMs(key: string): number {
  const entry = loginAttempts.get(key);
  if (!entry) return 0;
  if (Date.now() - entry.lastAttemptAt > FAILURE_WINDOW_MS) {
    loginAttempts.delete(key);
    return 0;
  }
  return Math.max(0, entry.lockedUntil - Date.now());
}

function recordLoginFailure(key: string): void {
  const entry = loginAttempts.get(key) ?? { failures: 0, lockedUntil: 0, lastAttemptAt: 0 };
  entry.failures += 1;
  entry.lastAttemptAt = Date.now();
  if (entry.failures >= LOCKOUT_AFTER) {
    entry.lockedUntil = Date.now() + Math.min(2 ** (entry.failures - LOCKOUT_AFTER) * 1000, MAX_LOCKOUT_MS);
  }
  loginAttempts.set(key, entry);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.lastAttemptAt > FAILURE_WINDOW_MS) loginAttempts.delete(key);
  }
}, 60_000).unref();

authRouter.get('/v1/auth/session', (req, res) => {
  const session = getSession(req);
  res.json({
    loggedIn: !!session,
    sub: session?.sub,
    permissions: session?.permissions,
    expiresAt: session?.exp,
    githubOauthEnabled,
    publicBaseUrl: config.publicBaseUrl,
  });
});

authRouter.post('/v1/auth/refresh', requireSession, (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  const expiresAt = setSessionCookie(res, { sub: session.sub, permissions: session.permissions });
  res.json({ ok: true, expiresAt });
});

authRouter.post('/v1/auth/login', (req, res) => {
  const key = req.ip ?? 'unknown';
  const lockedForMs = loginLockoutMs(key);
  if (lockedForMs > 0) {
    res.status(429).json({ error: `too many failed attempts - try again in ${Math.ceil(lockedForMs / 1000)}s` });
    return;
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !checkRootPassword(password)) {
    recordLoginFailure(key);
    res.status(401).json({ error: 'invalid password' });
    return;
  }

  loginAttempts.delete(key);
  setSessionCookie(res, { sub: 'root', permissions: ADMIN_PERMISSIONS });
  res.json({ ok: true });
});

authRouter.post('/v1/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

const OAUTH_STATE_COOKIE = 'oauth_state';

authRouter.get('/v1/auth/github/login', (_req, res) => {
  if (!githubOauthEnabled) {
    res.status(404).json({ error: 'GitHub OAuth is not configured' });
    return;
  }

  const state = randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`);

  const redirectUri = `${config.publicBaseUrl}/v1/auth/github/callback`;
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.githubOauthClientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user');
  url.searchParams.set('state', state);

  res.redirect(url.toString());
});

function parseCookieHeader(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

authRouter.get('/v1/auth/github/callback', async (req, res) => {
  if (!githubOauthEnabled) {
    res.redirect('/?auth_error=disabled');
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const cookieState = parseCookieHeader(req.header('cookie'))[OAUTH_STATE_COOKIE];
  res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);

  if (!code || !state || !cookieState || state !== cookieState) {
    log.warn('github oauth state mismatch', { hasCode: !!code, hasState: !!state, hasCookieState: !!cookieState });
    res.redirect('/?auth_error=state_mismatch');
    return;
  }

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.githubOauthClientId,
        client_secret: config.githubOauthClientSecret,
        code,
        redirect_uri: `${config.publicBaseUrl}/v1/auth/github/callback`,
      }),
    });
    const tokenBody = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!tokenBody.access_token) {
      throw new Error(tokenBody.error ?? 'no access_token in response');
    }

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: 'application/vnd.github+json' },
    });
    if (!userRes.ok) throw new Error(`GET /user failed: HTTP ${userRes.status}`);
    const user = (await userRes.json()) as { login: string };

    const permissions = getUserPermissions(user.login);
    if (!permissions) {
      log.warn('github oauth login rejected - not on allowlist', { login: user.login });
      res.redirect(`/?auth_error=not_allowed&user=${encodeURIComponent(user.login)}`);
      return;
    }

    setSessionCookie(res, { sub: user.login.toLowerCase(), permissions });
    log.info('github oauth login succeeded', { login: user.login, permissions });
    res.redirect('/');
  } catch (err) {
    log.error('github oauth callback failed', { error: String(err) });
    res.redirect('/?auth_error=failed');
  }
});
