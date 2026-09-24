import { createHash, randomBytes } from 'node:crypto';
import { Router, type Response } from '#http.js';
import { linkOauthAccount, resolveOauthAccount } from '#account.js';
import { config, discordBotEnabled, discordOauthEnabled, githubOauthEnabled } from '#config.js';
import { fetchMemberRoleIds } from '#discord.js';
import {
  type AuthIdentity,
  getAuthProfile,
  getLinkedAuthIdentities,
  getLinkedAuthProviders,
  removeAuthIdentity,
  setAuthDisplayName,
} from '#identity.js';
import { log } from '#logger.js';
import { beginMfaEnrollment, confirmMfaEnrollment, disableMfa, mfaStatus, regenerateRecoveryCodes, verifyMfa } from '#mfa.js';
import { PermissionFlag, serializeBits } from '#permissions.js';
import { accountDeletionBlocker, buildAccountExport, deleteAccount } from '#privacy.js';
import { beginPasskeyAuthentication, beginPasskeyReauthentication, beginPasskeyRegistration, finishPasskeyAuthentication, finishPasskeyReauthentication, finishPasskeyRegistration, listUserPasskeys, removeUserPasskey } from '#passkeys.js';
import { checkRootPassword, clearSessionCookie, getSession, requireSession, requireRecentAuthentication, sessionOptsFromReq, setSessionCookie } from '#session.js';
import { rateLimitPerUser } from '#util/rateLimit.js';
import {
  bumpSessionVersion,
  getDiscordGuildIds,
  getUserEffectivePermissions,
  listAllowedUsers,
  listSessionsForUser,
  revokeOtherSessionRecords,
  revokeSessionRecord,
  syncDiscordPerkRoles,
  recordAudit,
} from '#store/state.js';

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
const publicAuthRateLimit = rateLimitPerUser(30, 60_000);

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
  res.json({
    loggedIn: !!session,
    sub: session?.sub,
    displayName: profile?.displayName,
    avatarUrl: profile?.avatarUrl,
    identities: session ? getLinkedAuthIdentities(session.sub) : [],
    linkedProviders: session ? getLinkedAuthProviders(session.sub) : [],
    permissions: session ? serializeBits(session.permissions) : undefined,
    expiresAt: session?.exp,
    githubOauthEnabled,
    discordOauthEnabled,
    publicBaseUrl: config.publicBaseUrl,
    mfa: session ? { ...mfaStatus(session.sub), required: !session.mfaVerified } : undefined,
  });
});

authRouter.get('/v1/auth/mfa', requireSession, (_req, res) => {
  res.json(mfaStatus(res.locals.session.sub));
});

authRouter.post('/v1/auth/mfa/setup', requireSession, (_req, res) => {
  const userId = res.locals.session.sub;
  if (mfaStatus(userId).enabled) {
    res.status(409).json({ error: 'multi-factor authentication is already enabled' });
    return;
  }
  res.json(beginMfaEnrollment(userId));
});

authRouter.post('/v1/auth/mfa/confirm', requireSession, (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const result = confirmMfaEnrollment(res.locals.session.sub, token);
  if (!result) {
    res.status(400).json({ error: 'the authenticator code is invalid or the enrollment has expired' });
    return;
  }
  res.json({ enabled: true, recoveryCodes: result.recoveryCodes });
});

authRouter.post('/v1/auth/mfa/verify', (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!verifyMfa(session.sub, token).ok) {
    res.status(401).json({ error: 'the authenticator or recovery code is invalid' });
    return;
  }
  const expiresAt = setSessionCookie(res, { sub: session.sub, permissions: session.permissions, mfaVerified: true, reauthenticatedAt: Date.now() }, { sid: session.sid });
  res.json({ ok: true, expiresAt });
});

authRouter.post('/v1/auth/reauthenticate', requireSession, (req, res) => {
  const session = res.locals.session;
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const token = typeof req.body?.mfaToken === 'string' ? req.body.mfaToken : '';
  const valid = session.sub === 'root' ? checkRootPassword(password) : mfaStatus(session.sub).enabled && verifyMfa(session.sub, token).ok;
  if (!valid) {
    res.error('reauthentication_failed', 'the supplied reauthentication proof is invalid', 401, false);
    return;
  }
  const expiresAt = setSessionCookie(res, { sub: session.sub, permissions: session.permissions, mfaVerified: session.mfaVerified, reauthenticatedAt: Date.now() }, { sid: session.sid });
  res.json({ ok: true, expiresAt });
});

authRouter.get('/v1/auth/passkeys', requireSession, (_req, res) => {
  res.json({ passkeys: listUserPasskeys(res.locals.session.sub) });
});

authRouter.post('/v1/auth/passkeys/register/options', requireSession, requireRecentAuthentication(), async (_req, res) => {
  try {
    res.json(await beginPasskeyRegistration(res.locals.session.sub));
  } catch (error) {
    res.error('passkey_unavailable', error instanceof Error ? error.message : String(error), 503, true);
  }
});

authRouter.post('/v1/auth/passkeys/register', requireSession, requireRecentAuthentication(), async (req, res) => {
  const response = req.body as Record<string, unknown>;
  if (!response || typeof response.id !== 'string' || typeof response.rawId !== 'string' || typeof response.response !== 'object' || response.response === null) {
    res.error('invalid_passkey_response', 'the passkey registration response is malformed', 400, false);
    return;
  }
  try {
    const credential = await finishPasskeyRegistration(res.locals.session.sub, response as never, typeof response.name === 'string' ? response.name : undefined);
    recordAudit(res.locals.session.sub, 'auth.passkey.add', credential.id, credential.name ?? 'passkey registered');
    res.status(201).json({ passkey: listUserPasskeys(res.locals.session.sub).find((candidate) => candidate.id === credential.id) });
  } catch (error) {
    res.error('passkey_registration_failed', error instanceof Error ? error.message : String(error), 400, false);
  }
});

authRouter.delete('/v1/auth/passkeys/:id', requireSession, requireRecentAuthentication(), (req, res) => {
  const id = typeof req.params.id === 'string' ? req.params.id : '';
  if (!id || !removeUserPasskey(res.locals.session.sub, id)) {
    res.error('passkey_not_found', 'passkey not found', 404, false);
    return;
  }
  recordAudit(res.locals.session.sub, 'auth.passkey.remove', id, 'passkey removed');
  res.json({ ok: true });
});

authRouter.post('/v1/auth/passkeys/options', publicAuthRateLimit, async (_req, res) => {
  try {
    res.json(await beginPasskeyAuthentication());
  } catch (error) {
    res.error('passkey_unavailable', error instanceof Error ? error.message : String(error), 503, true);
  }
});

authRouter.post('/v1/auth/passkeys/verify', publicAuthRateLimit, async (req, res) => {
  const response = req.body as Record<string, unknown>;
  if (!response || typeof response.id !== 'string' || typeof response.rawId !== 'string' || typeof response.response !== 'object' || response.response === null) {
    res.error('invalid_passkey_response', 'the passkey authentication response is malformed', 400, false);
    return;
  }
  try {
    const result = await finishPasskeyAuthentication(response as never);
    const permissions = result.userId === 'root' ? PermissionFlag.administrator : getUserEffectivePermissions(result.userId);
    const expiresAt = setSessionCookie(res, { sub: result.userId, permissions, mfaVerified: true, reauthenticatedAt: Date.now() }, sessionOptsFromReq(req));
    recordAudit(result.userId, 'auth.passkey.login', result.credential.id, 'passkey login succeeded');
    res.json({ ok: true, expiresAt });
  } catch (error) {
    res.error('passkey_authentication_failed', error instanceof Error ? error.message : String(error), 401, false);
  }
});

authRouter.post('/v1/auth/passkeys/reauth/options', requireSession, async (_req, res) => {
  try {
    res.json(await beginPasskeyReauthentication(res.locals.session.sub));
  } catch (error) {
    res.error('passkey_unavailable', error instanceof Error ? error.message : String(error), 503, true);
  }
});

authRouter.post('/v1/auth/passkeys/reauth/verify', requireSession, async (req, res) => {
  const response = req.body as Record<string, unknown>;
  if (!response || typeof response.id !== 'string' || typeof response.rawId !== 'string' || typeof response.response !== 'object' || response.response === null) {
    res.error('invalid_passkey_response', 'the passkey authentication response is malformed', 400, false);
    return;
  }
  try {
    const credential = await finishPasskeyReauthentication(res.locals.session.sub, response as never);
    const expiresAt = setSessionCookie(
      res,
      { sub: res.locals.session.sub, permissions: res.locals.session.permissions, mfaVerified: res.locals.session.mfaVerified, reauthenticatedAt: Date.now() },
      { sid: res.locals.session.sid },
    );
    recordAudit(res.locals.session.sub, 'auth.passkey.reauthenticate', credential.id, 'passkey reauthentication succeeded');
    res.json({ ok: true, expiresAt });
  } catch (error) {
    res.error('passkey_reauthentication_failed', error instanceof Error ? error.message : String(error), 401, false);
  }
});

authRouter.post('/v1/auth/mfa/disable', requireSession, (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!disableMfa(res.locals.session.sub, token)) {
    res.status(400).json({ error: 'the authenticator or recovery code is invalid' });
    return;
  }
  res.json({ enabled: false, recoveryCodesRemaining: 0 });
});

authRouter.post('/v1/auth/mfa/recovery-codes', requireSession, (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  const recoveryCodes = regenerateRecoveryCodes(res.locals.session.sub, token);
  if (!recoveryCodes) {
    res.status(400).json({ error: 'the authenticator or recovery code is invalid' });
    return;
  }
  res.json({ recoveryCodes });
});

authRouter.get('/v1/auth/privacy/export', requireSession, (_req, res) => {
  const userId = res.locals.session.sub;
  const payload = buildAccountExport(userId);
  recordAudit(userId, 'privacy.export', userId, 'account export generated');
  const filename = `dkrypt-account-export-${userId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.type('application/json').send(`${JSON.stringify(payload, null, 2)}\n`);
});

authRouter.post('/v1/auth/privacy/delete', requireSession, requireRecentAuthentication(), (req, res) => {
  const userId = res.locals.session.sub;
  const confirmation = typeof req.body?.confirmation === 'string' ? req.body.confirmation.trim() : '';
  if (confirmation !== 'DELETE MY ACCOUNT') {
    res.error('confirmation_required', 'type DELETE MY ACCOUNT to confirm account deletion', 400, false);
    return;
  }
  const blocker = accountDeletionBlocker(userId);
  if (blocker) {
    res.error('account_deletion_blocked', blocker, 409, false);
    return;
  }
  const result = deleteAccount(userId);
  if (!result.ok) {
    res.error('account_deletion_failed', result.error ?? 'account deletion failed', 400, false);
    return;
  }
  clearSessionCookie(res);
  res.json({ ok: true });
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

authRouter.delete('/v1/auth/connections/:provider', requireSession, (req, res) => {
  const userId = res.locals.session.sub;
  const provider = req.params.provider;
  if (userId === 'root') {
    res.status(400).json({ error: 'the root account does not have OAuth connections' });
    return;
  }
  if (provider !== 'github' && provider !== 'discord') {
    res.status(400).json({ error: 'provider must be github or discord' });
    return;
  }
  if (getLinkedAuthIdentities(userId).length < 2) {
    res.status(400).json({ error: 'connect another provider before removing this sign-in method' });
    return;
  }
  const profile = removeAuthIdentity(userId, provider);
  if (!profile) {
    res.status(404).json({ error: 'connection not found' });
    return;
  }
  bumpSessionVersion(userId);
  setSessionCookie(res, { sub: userId, permissions: getUserEffectivePermissions(userId) ?? 0n, reauthenticatedAt: res.locals.session.reauthenticatedAt }, sessionOptsFromReq(req));
  res.json({ identities: getLinkedAuthIdentities(userId), linkedProviders: getLinkedAuthProviders(userId) });
});

authRouter.post('/v1/auth/refresh', requireSession, (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }

  const permissions = session.sub === 'root' ? PermissionFlag.administrator : getUserEffectivePermissions(session.sub);
  const expiresAt = setSessionCookie(res, { sub: session.sub, permissions, mfaVerified: session.mfaVerified, reauthenticatedAt: session.reauthenticatedAt }, { sid: session.sid });
  res.json({ ok: true, expiresAt });
});

authRouter.post('/v1/auth/login', publicAuthRateLimit, (req, res) => {
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

  const mfa = mfaStatus('root');
  const mfaToken = typeof req.body?.mfaToken === 'string' ? req.body.mfaToken : '';
  if (mfa.enabled) {
    if (!mfaToken || !verifyMfa('root', mfaToken).ok) {
      res.status(401).json({ error: 'multi-factor authentication is required', code: 'mfa_required' });
      return;
    }
  }

  loginAttempts.delete(key);
  setSessionCookie(res, { sub: 'root', permissions: PermissionFlag.administrator, mfaVerified: true, reauthenticatedAt: Date.now() }, sessionOptsFromReq(req));
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
const oauthConnections = new Map<string, { provider: 'github' | 'discord'; userId?: string; codeVerifier: string; expiresAt: number }>();

function oauthCookie(name: string, value: string, maxAge: number): string {
  const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function oauthUserId(provider: 'github' | 'discord', providerId: string, username: string): string {
  const stableId = `${provider}:${providerId}`;
  const legacy = listAllowedUsers().find((user) => user.username === username.toLowerCase());
  return legacy?.username ?? stableId;
}

function createOauthState(provider: 'github' | 'discord', userId?: string): { state: string; codeVerifier: string } {
  const state = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(32).toString('base64url');
  oauthConnections.set(state, { provider, userId, codeVerifier, expiresAt: Date.now() + 600_000 });
  return { state, codeVerifier };
}

function consumeOauthConnection(provider: 'github' | 'discord', state: string): { userId?: string; codeVerifier: string } | undefined {
  const connection = oauthConnections.get(state);
  oauthConnections.delete(state);
  if (!connection || connection.provider !== provider || connection.expiresAt < Date.now()) return undefined;
  return { userId: connection.userId, codeVerifier: connection.codeVerifier };
}

setInterval(() => {
  const now = Date.now();
  for (const [state, connection] of oauthConnections) {
    if (connection.expiresAt < now) oauthConnections.delete(state);
  }
}, 60_000).unref();

function startGithubLogin(res: Response, userId?: string): void {
  if (!githubOauthEnabled) {
    res.status(404).json({ error: 'GitHub OAuth is not configured' });
    return;
  }

  const { state, codeVerifier } = createOauthState('github', userId);
  res.setHeader('Set-Cookie', oauthCookie(GITHUB_OAUTH_STATE_COOKIE, state, 600));

  const redirectUri = `${config.publicBaseUrl}/v1/auth/github/callback`;
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.githubOauthClientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');

  res.redirect(url.toString());
}

authRouter.get('/v1/auth/github/login', (_req, res) => {
  startGithubLogin(res);
});

authRouter.get('/v1/auth/github/connect', requireSession, (_req, res) => {
  if (res.locals.session.sub === 'root') {
    res.status(400).json({ error: 'the root account cannot connect OAuth identities' });
    return;
  }
  startGithubLogin(res, res.locals.session.sub);
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
  const oauthConnection = consumeOauthConnection('github', state);
  const linkUserId = oauthConnection?.userId;

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.githubOauthClientId,
        client_secret: config.githubOauthClientSecret,
        code,
        redirect_uri: `${config.publicBaseUrl}/v1/auth/github/callback`,
        code_verifier: oauthConnection?.codeVerifier,
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
    const identity: AuthIdentity = {
      provider: 'github',
      providerId: String(user.id),
      username: user.login,
      displayName: user.name || user.login,
      email,
      avatarUrl: user.avatar_url,
      source: 'oauth',
      updatedAt,
    };
    const profile = linkUserId
      ? linkOauthAccount(linkUserId, identity)
      : resolveOauthAccount({ fallbackUserId: oauthUserId('github', String(user.id), user.login), identity });
    const userId = profile.userId;
    const permissions = getUserEffectivePermissions(userId) ?? 0n;
    setSessionCookie(res, { sub: userId, permissions, mfaVerified: !mfaStatus(userId).enabled, reauthenticatedAt: Date.now() }, sessionOptsFromReq(req));
    log.info('github oauth login succeeded', { login: user.login, permissions: serializeBits(permissions) });
    res.redirect('/');
  } catch (err) {
    log.error('github oauth callback failed', { error: String(err) });
    res.redirect('/?auth_error=failed');
  }
});

function startDiscordLogin(res: Response, userId?: string): void {
  if (!discordOauthEnabled) {
    res.status(404).json({ error: 'Discord OAuth is not configured' });
    return;
  }

  const { state, codeVerifier } = createOauthState('discord', userId);
  res.setHeader('Set-Cookie', oauthCookie(DISCORD_OAUTH_STATE_COOKIE, state, 600));

  const redirectUri = `${config.publicBaseUrl}/v1/auth/discord/callback`;
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', config.discordOauthClientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify email connections');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', createHash('sha256').update(codeVerifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  res.redirect(url.toString());
}

authRouter.get('/v1/auth/discord/login', (_req, res) => {
  startDiscordLogin(res);
});

authRouter.get('/v1/auth/discord/connect', requireSession, (_req, res) => {
  if (res.locals.session.sub === 'root') {
    res.status(400).json({ error: 'the root account cannot connect OAuth identities' });
    return;
  }
  startDiscordLogin(res, res.locals.session.sub);
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
  const oauthConnection = consumeOauthConnection('discord', state);
  const linkUserId = oauthConnection?.userId;

  try {
    const redirectUri = `${config.publicBaseUrl}/v1/auth/discord/callback`;
    const tokenBody = new URLSearchParams({
      client_id: config.discordOauthClientId,
      client_secret: config.discordOauthClientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: oauthConnection?.codeVerifier ?? '',
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
    const identity: AuthIdentity = {
      provider: 'discord',
      providerId: user.id,
      username: user.username,
      displayName: user.global_name || user.username,
      email: user.email,
      avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : undefined,
      source: 'oauth',
      updatedAt,
    };
    const profile = linkUserId
      ? linkOauthAccount(linkUserId, identity)
      : resolveOauthAccount({
          fallbackUserId: oauthUserId('discord', user.id, `discord:${user.username}`),
          identity,
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
    setSessionCookie(res, { sub: userId, permissions, mfaVerified: !mfaStatus(userId).enabled, reauthenticatedAt: Date.now() }, sessionOptsFromReq(req));
    log.info('discord oauth login succeeded', { username: user.username, permissions: serializeBits(permissions) });
    res.redirect('/');
  } catch (err) {
    log.error('discord oauth callback failed', { error: String(err) });
    res.redirect('/?auth_error=discord_failed');
  }
});
