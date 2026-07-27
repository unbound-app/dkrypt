import { hasPermission, parseBits, PermissionFlag, permissionLabels } from '#lib/permissions';
import {
  accentState,
  setAccent,
  setSoundEnabled,
  setTheme,
  soundEnabledState,
  themePrefState,
  type ThemePref,
} from '#lib/ui.svelte';

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
  identities?: { provider: 'github' | 'discord'; username: string; displayName: string; avatarUrl?: string }[];
  linkedProviders?: ('github' | 'discord')[];

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

export function sessionCanSeeSettings(): boolean {
  return sessionHasAnyPermission([
    PermissionFlag.viewAutomation,
    PermissionFlag.manageDevices,
    PermissionFlag.manageAutomation,
    PermissionFlag.viewUsers,
    PermissionFlag.manageUsers,
    PermissionFlag.manageRoles,
    PermissionFlag.manageBackup,
    PermissionFlag.viewDevices,
    PermissionFlag.viewRoles,
    PermissionFlag.viewBackup,
  ]);
}

export async function refreshSession(): Promise<SessionInfo> {
  const res = await fetch('/v1/auth/session');
  const data = (await res.json()) as SessionInfo;
  Object.assign(sessionState, data);
  if (data.loggedIn) void syncThemeFromServer();
  return data;
}

export async function updateProfileDisplayName(displayName: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/v1/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? 'Could not update profile name.' };
  }
  await refreshSession();
  return { ok: true };
}

async function syncThemeFromServer(): Promise<void> {
  const res = await fetch('/v1/dashboard/me/prefs');
  if (!res.ok) return;
  const prefs = (await res.json()) as { theme?: ThemePref; accent?: string; sound?: boolean };
  if (prefs.theme && prefs.theme !== themePrefState.value) setTheme(prefs.theme);
  if (prefs.accent && prefs.accent !== accentState.value) setAccent(prefs.accent);
  if (prefs.sound !== undefined && prefs.sound !== soundEnabledState.value) setSoundEnabled(prefs.sound);
}

export interface NotificationPrefs {
  pushOnSuccess?: boolean;
  pushOnFailure?: boolean;
  pushOnAlerts?: boolean;
  pushOnKeyExpiry?: boolean;
  emailOnSuccess?: boolean;
  emailOnFailure?: boolean;
  emailOnAlerts?: boolean;
  emailOnKeyExpiry?: boolean;
  notifyEmail?: string;
}

export async function fetchNotificationPrefs(): Promise<NotificationPrefs & { accountEmail?: string }> {
  const res = await fetch('/v1/dashboard/me/prefs');
  if (!res.ok) return {};
  const prefs = (await res.json()) as NotificationPrefs & { accountEmail?: string };
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

export async function pushAccentPref(accent: string): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accent }),
  });
}

export async function pushSoundPref(sound: boolean): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sound }),
  });
}

export async function fetchPreferPrimaryDevicePref(): Promise<boolean> {
  const res = await fetch('/v1/dashboard/me/prefs');
  if (!res.ok) return false;
  const prefs = (await res.json()) as { preferPrimaryDevice?: boolean };
  return prefs.preferPrimaryDevice ?? false;
}

export async function pushPreferPrimaryDevicePref(preferPrimaryDevice: boolean): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferPrimaryDevice }),
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
