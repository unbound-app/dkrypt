import { hasPermission, parseBits, PermissionFlag, permissionKeys, permissionLabels, type PermissionMetaKey } from '#lib/permissions';
import { serverStateCache } from '#lib/serverStateCache.svelte';
import { resetTestFlightCatalogState } from '#lib/testFlightCatalogState.svelte';
import { clearPersistedTestFlightCatalog } from '#lib/testFlightCatalogPersistence';
import {
  accentState,
  highContrastState,
  formattingLocaleState,
  interfaceLanguageState,
  setAccent,
  setHighContrast,
  setFormattingLocale,
  setInterfaceLanguage,
  setSoundEnabled,
  setTheme,
  setDensity,
  setSettingsMode,
  setHomeLayoutPreferences,
  setHomeViewModes,
  homeLayoutPreferencesState,
  homeViewModesState,
  resetUserInterfacePreferences,
  soundEnabledState,
  themePrefState,
  type ThemePref,
} from '#lib/ui.svelte';
import type { FormattingLocalePreference } from '#lib/locale';
import type { InterfaceLanguagePreference } from '#lib/locale';
import type { HomeLayout, HomeViewModes } from '#lib/homeLayouts';
import type { DisplayDensity, SettingsMode } from '#lib/ui.svelte';

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
  deployment?: { ref: string };
  publicBaseUrl?: string;
  mfa?: { enabled: boolean; recoveryCodesRemaining: number; required: boolean };
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

export function sessionPermissionKeys(): PermissionMetaKey[] {
  return permissionKeys(sessionBits());
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
    PermissionFlag.requestTestFlightSubscriptions,
    PermissionFlag.manageTestFlightSubscriptions,
    PermissionFlag.viewBilling,
    PermissionFlag.manageBilling,
  ]);
}

export async function refreshSession(): Promise<SessionInfo> {
  const res = await fetch('/v1/auth/session');
  const data = (await res.json()) as SessionInfo;
  const previousSub = sessionState.sub?.trim();
  const identityChanged = data.loggedIn !== sessionState.loggedIn || data.sub !== sessionState.sub;
  const permissionsChanged = data.permissions !== sessionState.permissions;
  const accessChanged = identityChanged || permissionsChanged;
  const identitySwitched = previousSub && data.loggedIn && previousSub.toLowerCase() !== data.sub?.trim().toLowerCase();
  if (identitySwitched) resetUserInterfacePreferences();
  if (accessChanged) {
    serverStateCache.clear();
    const leavingIdentity = previousSub && (!data.loggedIn || previousSub.toLowerCase() !== data.sub?.trim().toLowerCase());
    if (previousSub && (leavingIdentity || permissionsChanged)) clearPersistedTestFlightCatalog(previousSub);
    resetTestFlightCatalogState();
  }
  Object.assign(sessionState, data);
  if (data.loggedIn) {
    if (accessChanged) serverStateCache.invalidateAll();
    void syncThemeFromServer();
  }
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
  const prefs = (await res.json()) as {
    formattingLocale?: FormattingLocalePreference;
    interfaceLanguage?: InterfaceLanguagePreference;
    theme?: ThemePref;
    accent?: string;
    sound?: boolean;
    highContrast?: boolean;
    density?: DisplayDensity;
    homeLayouts?: HomeLayout[];
    activeHomeLayoutId?: string;
    viewModes?: Partial<HomeViewModes>;
    settingsMode?: SettingsMode;
  };
  const formattingLocale = prefs.formattingLocale ?? 'system';
  if (formattingLocale !== formattingLocaleState.value) setFormattingLocale(formattingLocale);
  const interfaceLanguage = prefs.interfaceLanguage ?? 'system';
  if (interfaceLanguage !== interfaceLanguageState.value) setInterfaceLanguage(interfaceLanguage);
  if (prefs.theme && prefs.theme !== themePrefState.value) setTheme(prefs.theme);
  if (prefs.accent && prefs.accent !== accentState.value) setAccent(prefs.accent);
  if (prefs.highContrast !== undefined && prefs.highContrast !== highContrastState.value) setHighContrast(prefs.highContrast);
  if (prefs.sound !== undefined && prefs.sound !== soundEnabledState.value) setSoundEnabled(prefs.sound);
  if (prefs.density) setDensity(prefs.density);
  if (prefs.homeLayouts?.length) setHomeLayoutPreferences(prefs.homeLayouts, prefs.activeHomeLayoutId ?? prefs.homeLayouts[0]!.id);
  if (prefs.viewModes) setHomeViewModes(prefs.viewModes);
  if (prefs.settingsMode) setSettingsMode(prefs.settingsMode);
}

async function pushDashboardPreference(patch: Record<string, unknown>): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function pushDensityPref(density: DisplayDensity): Promise<void> {
  setDensity(density);
  return pushDashboardPreference({ density });
}

export async function pushHomeLayoutPreferences(layouts: HomeLayout[], activeId: string): Promise<void> {
  const previousLayouts = homeLayoutPreferencesState.layouts.map((layout) => ({ ...layout, order: [...layout.order], hidden: [...layout.hidden], collapsed: [...layout.collapsed] }));
  const previousActiveId = homeLayoutPreferencesState.activeId;
  setHomeLayoutPreferences(layouts, activeId);
  if (!sessionState.loggedIn) return;
  try {
    const response = await fetch('/v1/dashboard/me/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ homeLayouts: layouts, activeHomeLayoutId: activeId }),
    });
    if (!response.ok) throw new Error('Could not save Home layout preferences');
  } catch (error) {
    setHomeLayoutPreferences(previousLayouts, previousActiveId);
    throw error;
  }
}

export function pushHomeViewMode(key: keyof HomeViewModes, mode: HomeViewModes[keyof HomeViewModes]): Promise<void> {
  const viewModes = { ...homeViewModesState.value, [key]: mode };
  setHomeViewModes(viewModes);
  return pushDashboardPreference({ viewModes: { [key]: mode } });
}

export function pushSettingsModePref(mode: SettingsMode): Promise<void> {
  setSettingsMode(mode);
  return pushDashboardPreference({ settingsMode: mode });
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

export async function pushFormattingLocale(preference: FormattingLocalePreference): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formattingLocale: preference }),
  });
}

export async function pushInterfaceLanguage(preference: InterfaceLanguagePreference): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interfaceLanguage: preference }),
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

export async function pushHighContrastPref(highContrast: boolean): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ highContrast }),
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

export async function loginRoot(password: string, mfaToken?: string): Promise<{ ok: boolean; error?: string; code?: string; attemptsRemaining?: number }> {
  const res = await fetch('/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, mfaToken: mfaToken || undefined }),
  });
  if (res.ok) {
    await refreshSession();
    return { ok: true };
  }
  const data = await res.json().catch(() => ({}) as { error?: string; code?: string; attemptsRemaining?: number });
  if (res.status === 429) return { ok: false, error: data.error };
  return { ok: false, error: data.code === 'mfa_required' ? 'Enter your authenticator code to continue.' : 'Wrong password.', code: data.code, attemptsRemaining: data.attemptsRemaining };
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
  resetUserInterfacePreferences();
  if (sessionState.loggedIn) serverStateCache.clear();
  if (sessionState.sub) clearPersistedTestFlightCatalog(sessionState.sub);
  resetTestFlightCatalogState();
  sessionState.loggedIn = false;
}
