import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { config, githubOauthEnabled } from '../config.js';
import { log } from '../logger.js';
import { checkRootPassword, clearSessionCookie, getSession, setSessionCookie } from '../session.js';
import { getUserRole } from '../store/state.js';

export const authRouter = Router();

authRouter.get('/v1/auth/session', (req, res) => {
  const session = getSession(req);
  res.json({ loggedIn: !!session, sub: session?.sub, role: session?.role, githubOauthEnabled });
});

authRouter.post('/v1/auth/login', (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !checkRootPassword(password)) {
    res.status(401).json({ error: 'invalid password' });
    return;
  }
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
