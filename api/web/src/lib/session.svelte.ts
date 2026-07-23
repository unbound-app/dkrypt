import { hasPermission, parseBits, PermissionFlag, permissionLabels } from './permissions';
import { accentState, densityState, setAccent, setDensity, setTheme, themePrefState, type Density, type ThemePref } from './ui.svelte';

export interface Role {
  id: string;
  name: string;
  color: string;
  permissions: string;
  position: number;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export function permissionsSummary(bits: bigint): string {
  if (hasPermission(bits, PermissionFlag.administrator)) return 'administrator';
  if (bits === 0n) return 'viewer';
  return 'custom';
}

export interface SessionInfo {
  loggedIn: boolean;
  sub?: string;
  displayName?: string;
  avatarUrl?: string;
  // Decimal-string-serialized bigint bitfield, as returned by the API - parse with sessionBits().
  permissions?: string;
  expiresAt?: number;
  githubOauthEnabled: boolean;
  discordOauthEnabled: boolean;
  publicBaseUrl?: string;
}

export const sessionState = $state<SessionInfo>({ loggedIn: false, githubOauthEnabled: false, discordOauthEnabled: false });

export function sessionBits(): bigint {
  return parseBits(sessionState.permissions);
}

export function sessionHasPermission(flag: bigint): boolean {
  return hasPermission(sessionBits(), flag);
}

export function sessionHasAnyPermission(flags: bigint[]): boolean {
  return flags.some((flag) => sessionHasPermission(flag));
}

export function sessionPermissionLabels(): string[] {
  return permissionLabels(sessionBits());
}

// Any permission that unlocks something under the Settings tab - shared by the tab bar, the
// Settings subtab list, and the command palette so "can they see Settings at all" is defined once.
export function sessionCanSeeSettings(): boolean {
  return sessionHasAnyPermission([
    PermissionFlag.manageWatches,
    PermissionFlag.manageDevices,
    PermissionFlag.manageSchedulerSettings,
    PermissionFlag.triggerDispatch,
    PermissionFlag.manageAppleAuth,
    PermissionFlag.viewUsers,
    PermissionFlag.manageUsers,
    PermissionFlag.manageRoles,
    PermissionFlag.manageBackup,
  ]);
}

export async function refreshSession(): Promise<SessionInfo> {
  const res = await fetch('/v1/auth/session');
  const data = (await res.json()) as SessionInfo;
  Object.assign(sessionState, data);
  if (data.loggedIn) void syncThemeFromServer();
  return data;
}

async function syncThemeFromServer(): Promise<void> {
  const res = await fetch('/v1/dashboard/me/prefs');
  if (!res.ok) return;
  const prefs = (await res.json()) as { theme?: ThemePref; density?: Density; accent?: string };
  if (prefs.theme && prefs.theme !== themePrefState.value) setTheme(prefs.theme);
  if (prefs.density && prefs.density !== densityState.value) setDensity(prefs.density);
  if (prefs.accent && prefs.accent !== accentState.value) setAccent(prefs.accent);
}

export interface NotificationPrefs {
  pushOnSuccess?: boolean;
  pushOnFailure?: boolean;
}

export async function fetchNotificationPrefs(): Promise<NotificationPrefs> {
  const res = await fetch('/v1/dashboard/me/prefs');
  if (!res.ok) return {};
  const prefs = (await res.json()) as NotificationPrefs;
  return prefs;
}

export async function pushNotificationPrefs(patch: NotificationPrefs): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function pushThemePref(theme: ThemePref): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
  });
}

export async function pushDensityPref(density: Density): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ density }),
  });
}

export async function pushAccentPref(accent: string): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accent }),
  });
}

export async function loginRoot(password: string): Promise<{ ok: boolean; error?: string; attemptsRemaining?: number }> {
  const res = await fetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.ok) {
    await refreshSession();
    return { ok: true };
  }
  const data = await res.json().catch(() => ({}) as { error?: string; attemptsRemaining?: number });
  if (res.status === 429) return { ok: false, error: data.error };
  return { ok: false, error: 'Wrong password.', attemptsRemaining: data.attemptsRemaining };
}

export async function refreshSessionTtl(): Promise<boolean> {
  const res = await fetch('/v1/auth/refresh', { method: 'POST' });
  if (!res.ok) return false;
  await refreshSession();
  return true;
}

export async function logout(): Promise<void> {
  await fetch('/v1/auth/logout', { method: 'POST' });
  await refreshSession();
}

export async function logoutEverywhere(): Promise<void> {
  await fetch('/v1/auth/logout-everywhere', { method: 'POST' });
  await refreshSession();
}

export function markLoggedOut(): void {
  sessionState.loggedIn = false;
}
