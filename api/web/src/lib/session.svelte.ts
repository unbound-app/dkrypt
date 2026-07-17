import { setTheme, themeState, type Theme } from './ui.svelte';

export interface Permissions {
  decrypt: boolean;
  viewApiKeys: boolean;
  approveApiKeys: boolean;
  revokeApiKeys: boolean;
  manageScheduler: boolean;
  triggerDispatch: boolean;
  manageAppleAuth: boolean;
  viewLogs: boolean;
  viewUsers: boolean;
  manageUsers: boolean;
}

export const PERMISSION_KEYS: (keyof Permissions)[] = [
  'decrypt',
  'viewApiKeys',
  'approveApiKeys',
  'revokeApiKeys',
  'manageScheduler',
  'triggerDispatch',
  'manageAppleAuth',
  'viewLogs',
  'viewUsers',
  'manageUsers',
];

export const VIEWER_PERMISSIONS: Permissions = {
  decrypt: false,
  viewApiKeys: false,
  approveApiKeys: false,
  revokeApiKeys: false,
  manageScheduler: false,
  triggerDispatch: false,
  manageAppleAuth: false,
  viewLogs: false,
  viewUsers: false,
  manageUsers: false,
};

export const ADMIN_PERMISSIONS: Permissions = {
  decrypt: true,
  viewApiKeys: true,
  approveApiKeys: true,
  revokeApiKeys: true,
  manageScheduler: true,
  triggerDispatch: true,
  manageAppleAuth: true,
  viewLogs: true,
  viewUsers: true,
  manageUsers: true,
};

// Some capabilities imply others - keep that consistent no matter how permissions were set.
export function normalizePermissions(p: Permissions): Permissions {
  return {
    ...p,
    viewApiKeys: p.viewApiKeys || p.approveApiKeys || p.revokeApiKeys,
    viewUsers: p.viewUsers || p.manageUsers,
  };
}

export type PermissionGroup = 'Decryption' | 'API Keys' | 'Scheduler & Dispatch' | 'Apple Authentication' | 'Logs' | 'Users';

export interface PermissionMeta {
  key: keyof Permissions;
  label: string;
  description: string;
  group: PermissionGroup;
  impliedBy?: (keyof Permissions)[];
}

// Single source of truth for permission copy/grouping - used by the permission editor,
// the allowlist table's badges, and the "your permissions" breakdown.
export const PERMISSION_META: PermissionMeta[] = [
  { key: 'decrypt', label: 'Decrypt apps', description: 'Queue decrypts and request their own API keys', group: 'Decryption' },
  {
    key: 'viewApiKeys',
    label: 'View all keys',
    description: 'See every key across every user, not just their own',
    group: 'API Keys',
    impliedBy: ['approveApiKeys', 'revokeApiKeys'],
  },
  {
    key: 'approveApiKeys',
    label: 'Approve requests',
    description: 'Approve or deny pending key requests; their own requests auto-approve',
    group: 'API Keys',
  },
  {
    key: 'revokeApiKeys',
    label: "Revoke anyone's key",
    description: "Revoke or bulk-revoke any user's key, not just their own",
    group: 'API Keys',
  },
  {
    key: 'manageScheduler',
    label: 'Manage scheduler',
    description: 'Edit watch/dispatch settings and the poll cron',
    group: 'Scheduler & Dispatch',
  },
  {
    key: 'triggerDispatch',
    label: 'Trigger dispatch',
    description: 'Manually run a check, preview the next dispatch, test the webhook, dismiss auth alerts',
    group: 'Scheduler & Dispatch',
  },
  {
    key: 'manageAppleAuth',
    label: 'Apple ID re-authentication',
    description: 'Run the App Store sign-in flow - real Apple ID credentials pass through this',
    group: 'Apple Authentication',
  },
  { key: 'viewLogs', label: 'View logs', description: 'See the live scheduler/job log feed', group: 'Logs' },
  {
    key: 'viewUsers',
    label: 'View allowlist',
    description: 'See who has access and what they can do',
    group: 'Users',
    impliedBy: ['manageUsers'],
  },
  {
    key: 'manageUsers',
    label: 'Manage allowlist',
    description: "Add or remove people, change anyone's permissions",
    group: 'Users',
  },
];

export function permissionsSummary(p?: Permissions): string {
  if (!p) return '';
  const values = Object.values(p);
  if (values.every(Boolean)) return 'admin';
  if (values.every((v) => !v)) return 'viewer';
  return 'custom';
}

export interface SessionInfo {
  loggedIn: boolean;
  sub?: string;
  permissions?: Permissions;
  expiresAt?: number;
  githubOauthEnabled: boolean;
  publicBaseUrl?: string;
}

export const sessionState = $state<SessionInfo>({ loggedIn: false, githubOauthEnabled: false });

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
  const prefs = (await res.json()) as { theme?: Theme };
  if (prefs.theme && prefs.theme !== themeState.value) setTheme(prefs.theme);
}

export async function pushThemePref(theme: Theme): Promise<void> {
  if (!sessionState.loggedIn) return;
  await fetch('/v1/dashboard/me/prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme }),
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
