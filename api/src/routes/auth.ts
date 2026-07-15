import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { config, githubOauthEnabled } from '../config.js';
import { log } from '../logger.js';
import { checkRootPassword, clearSessionCookie, getSession, setSessionCookie } from '../session.js';
import { getUserRole } from '../store/state.js';

export const authRouter = Router();

// Per-IP login lockout: after LOCKOUT_AFTER consecutive failures, each
// further attempt is rejected with a growing delay instead of being
// checked at all. Entries reset on success or after FAILURE_WINDOW_MS of
// no attempts; a periodic sweep bounds the map's size.
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
    role: session?.role,
    githubOauthEnabled,
    publicBaseUrl: config.publicBaseUrl,
  });
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
  setSessionCookie(res, { sub: 'root', role: 'admin' });
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
    res.status(404).send('GitHub OAuth is not configured');
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const cookieState = parseCookieHeader(req.header('cookie'))[OAUTH_STATE_COOKIE];
  res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);

  if (!code || !state || !cookieState || state !== cookieState) {
    res.status(400).send('OAuth state mismatch - please try signing in again.');
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

    const role = getUserRole(user.login);
    if (!role) {
      res
        .status(403)
        .send(
          `<p>GitHub user <b>${user.login}</b> isn't on the allowlist for this dashboard. Ask an admin to add you.</p>`,
        );
      return;
    }

    setSessionCookie(res, { sub: user.login.toLowerCase(), role });
    res.redirect('/');
  } catch (err) {
    log.error('github oauth callback failed', { error: String(err) });
    res.status(500).send('GitHub sign-in failed - check the server logs.');
  }
});
