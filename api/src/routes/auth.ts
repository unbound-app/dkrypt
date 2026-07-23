import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { resolveOauthAccount } from '../account.js';
import { canCreateApiKeyImmediately, getBillingEntitlements } from '../billing.js';
import { config, discordBotEnabled, discordOauthEnabled, githubOauthEnabled } from '../config.js';
import { fetchMemberRoleIds } from '../discord.js';
import {
  type AuthIdentity,
  getAuthProfile,
  getLinkedAuthIdentities,
  getLinkedAuthProviders,
  setAuthDisplayName,
} from '../identity.js';
import { log } from '../logger.js';
import { PermissionFlag, serializeBits } from '../permissions.js';
import { checkRootPassword, clearSessionCookie, getSession, requireSession, sessionOptsFromReq, setSessionCookie } from '../session.js';
import {
  bumpSessionVersion,
  getDiscordGuildIds,
  getUserEffectivePermissions,
  listAllowedUsers,
  listSessionsForUser,
  revokeOtherSessionRecords,
  revokeSessionRecord,
  syncDiscordPerkRoles,
} from '../store/state.js';

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
  const profile = session ? getAuthProfile(session.sub) : undefined;
  const billingEntitlements = session ? getBillingEntitlements(session.sub) : undefined;
  res.json({
    loggedIn: !!session,
    sub: session?.sub,
    displayName: profile?.displayName,
    avatarUrl: profile?.avatarUrl,
    identities: session ? getLinkedAuthIdentities(session.sub) : [],
    linkedProviders: session ? getLinkedAuthProviders(session.sub) : [],
    apiKeysAutoApprove:
      !!session &&
      !!billingEntitlements &&
      canCreateApiKeyImmediately(session.permissions, billingEntitlements),
    permissions: session ? serializeBits(session.permissions) : undefined,
    expiresAt: session?.exp,
    githubOauthEnabled,
    discordOauthEnabled,
    publicBaseUrl: config.publicBaseUrl,
  });
});

authRouter.patch('/v1/auth/profile', requireSession, (req, res) => {
  const userId = res.locals.session.sub;
  if (userId === 'root') {
    res.status(400).json({ error: 'the root account does not have an OAuth profile' });
    return;
  }
  const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
  if (!displayName || displayName.length > 64 || /[\u0000-\u001f\u007f]/.test(displayName)) {
    res.status(400).json({ error: 'displayName must be between 1 and 64 characters' });
    return;
  }
  const profile = setAuthDisplayName(userId, displayName);
  if (!profile) {
    res.status(404).json({ error: 'profile not found' });
    return;
  }
  res.json({ displayName: profile.displayName, linkedProviders: getLinkedAuthProviders(userId) });
});

authRouter.post('/v1/auth/refresh', requireSession, (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }

  // Re-check current permissions rather than carrying the old cookie's forward -
  // otherwise a revoked/downgraded user keeps stale access for as long as they keep refreshing.
  const permissions = session.sub === 'root' ? PermissionFlag.administrator : getUserEffectivePermissions(session.sub);
  if (permissions === undefined) {
    clearSessionCookie(res);
    res.status(401).json({ error: 'no longer allowed' });
    return;
  }

  const expiresAt = setSessionCookie(res, { sub: session.sub, permissions }, { sid: session.sid });
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
    const failures = loginAttempts.get(key)?.failures ?? 0;
    const attemptsRemaining = Math.max(0, LOCKOUT_AFTER - failures);
    res.status(401).json({ error: 'invalid password', attemptsRemaining });
    return;
  }

  loginAttempts.delete(key);
  setSessionCookie(res, { sub: 'root', permissions: PermissionFlag.administrator }, sessionOptsFromReq(req));
  res.json({ ok: true });
});

authRouter.post('/v1/auth/logout', (req, res) => {
  const session = getSession(req);
  if (session) revokeSessionRecord(session.sid, session.sub);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.post('/v1/auth/logout-everywhere', requireSession, (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  bumpSessionVersion(session.sub);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get('/v1/auth/sessions', requireSession, (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  res.json(listSessionsForUser(session.sub).map((s) => ({ ...s, current: s.id === session.sid })));
});

authRouter.delete('/v1/auth/sessions/:id', requireSession, (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  const ok = revokeSessionRecord(req.params.id, session.sub);
  if (!ok) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  if (req.params.id === session.sid) clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.post('/v1/auth/sessions/revoke-others', requireSession, (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  const revoked = revokeOtherSessionRecords(session.sub, session.sid);
  res.json({ ok: true, revoked });
});

const GITHUB_OAUTH_STATE_COOKIE = 'github_oauth_state';
const DISCORD_OAUTH_STATE_COOKIE = 'discord_oauth_state';

function oauthCookie(name: string, value: string, maxAge: number): string {
  const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function oauthUserId(provider: 'github' | 'discord', providerId: string, username: string): string {
  const stableId = `${provider}:${providerId}`;
  const legacy = listAllowedUsers().find((user) => user.username === username.toLowerCase());
  return legacy?.username ?? stableId;
}

authRouter.get('/v1/auth/github/login', (_req, res) => {
  if (!githubOauthEnabled) {
    res.status(404).json({ error: 'GitHub OAuth is not configured' });
    return;
  }

  const state = randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', oauthCookie(GITHUB_OAUTH_STATE_COOKIE, state, 600));

  const redirectUri = `${config.publicBaseUrl}/v1/auth/github/callback`;
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.githubOauthClientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
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
  const cookieState = parseCookieHeader(req.header('cookie'))[GITHUB_OAUTH_STATE_COOKIE];
  res.setHeader('Set-Cookie', oauthCookie(GITHUB_OAUTH_STATE_COOKIE, '', 0));

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
    const user = (await userRes.json()) as {
      id: number;
      login: string;
      name?: string | null;
      email?: string | null;
      avatar_url?: string;
    };

    let email = user.email ?? undefined;
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${tokenBody.access_token}`, Accept: 'application/vnd.github+json' },
      });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as { email: string; primary: boolean; verified: boolean }[];
        email = emails.find((candidate) => candidate.primary && candidate.verified)?.email;
      }
    }

    const updatedAt = new Date().toISOString();
    const profile = resolveOauthAccount({
      fallbackUserId: oauthUserId('github', String(user.id), user.login),
      identity: {
        provider: 'github',
        providerId: String(user.id),
        username: user.login,
        displayName: user.name || user.login,
        email,
        avatarUrl: user.avatar_url,
        source: 'oauth',
        updatedAt,
      },
    });
    const userId = profile.userId;
    const permissions = getUserEffectivePermissions(userId) ?? 0n;
    setSessionCookie(res, { sub: userId, permissions }, sessionOptsFromReq(req));
    log.info('github oauth login succeeded', { login: user.login, permissions: serializeBits(permissions) });
    res.redirect('/');
  } catch (err) {
    log.error('github oauth callback failed', { error: String(err) });
    res.redirect('/?auth_error=failed');
  }
});

authRouter.get('/v1/auth/discord/login', (_req, res) => {
  if (!discordOauthEnabled) {
    res.status(404).json({ error: 'Discord OAuth is not configured' });
    return;
  }

  const state = randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', oauthCookie(DISCORD_OAUTH_STATE_COOKIE, state, 600));

  const redirectUri = `${config.publicBaseUrl}/v1/auth/discord/callback`;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.discordOauthClientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify email connections');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

authRouter.get('/v1/auth/discord/callback', async (req, res) => {
  if (!discordOauthEnabled) {
    res.redirect('/?auth_error=discord_disabled');
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const cookieState = parseCookieHeader(req.header('cookie'))[DISCORD_OAUTH_STATE_COOKIE];
  res.setHeader('Set-Cookie', oauthCookie(DISCORD_OAUTH_STATE_COOKIE, '', 0));

  if (!code || !state || !cookieState || state !== cookieState) {
    log.warn('discord oauth state mismatch', { hasCode: !!code, hasState: !!state, hasCookieState: !!cookieState });
    res.redirect('/?auth_error=state_mismatch');
    return;
  }

  try {
    const redirectUri = `${config.publicBaseUrl}/v1/auth/discord/callback`;
    const tokenBody = new URLSearchParams({
      client_id: config.discordOauthClientId,
      client_secret: config.discordOauthClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    const token = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (!token.access_token) throw new Error(token.error ?? 'no access_token in response');

    const userRes = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userRes.ok) throw new Error(`GET /users/@me failed: HTTP ${userRes.status}`);
    const user = (await userRes.json()) as {
      id: string;
      username: string;
      global_name?: string | null;
      email?: string;
      avatar?: string | null;
    };

    const connectionsRes = await fetch('https://discord.com/api/v10/users/@me/connections', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const connections = connectionsRes.ok
      ? ((await connectionsRes.json()) as {
          id: string;
          name: string;
          type: string;
          verified?: boolean;
        }[])
      : [];
    if (!connectionsRes.ok) log.warn('discord connections lookup failed', { status: connectionsRes.status });

    const updatedAt = new Date().toISOString();
    const discoveredIdentities: AuthIdentity[] = connections
      .filter(
        (connection) =>
          connection.type === 'github' &&
          connection.verified === true &&
          connection.id.length > 0 &&
          connection.name.length > 0,
      )
      .map((connection) => ({
        provider: 'github',
        providerId: connection.id,
        username: connection.name,
        displayName: connection.name,
        source: 'discord_connection',
        updatedAt,
      }));
    const profile = resolveOauthAccount({
      fallbackUserId: oauthUserId('discord', user.id, `discord:${user.username}`),
      identity: {
        provider: 'discord',
        providerId: user.id,
        username: user.username,
        displayName: user.global_name || user.username,
        email: user.email,
        avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : undefined,
        source: 'oauth',
        updatedAt,
      },
      discoveredIdentities,
    });
    const userId = profile.userId;
    const guildIds = getDiscordGuildIds();
    if (discordBotEnabled && guildIds.length > 0) {
      syncDiscordPerkRoles(
        userId,
        await Promise.all(guildIds.map(async (guildId) => ({ guildId, roleIds: await fetchMemberRoleIds(guildId, user.id) }))),
      );
    }
    const permissions = getUserEffectivePermissions(userId) ?? 0n;
    setSessionCookie(res, { sub: userId, permissions }, sessionOptsFromReq(req));
    log.info('discord oauth login succeeded', { username: user.username, permissions: serializeBits(permissions) });
    res.redirect('/');
  } catch (err) {
    log.error('discord oauth callback failed', { error: String(err) });
    res.redirect('/?auth_error=discord_failed');
  }
});
