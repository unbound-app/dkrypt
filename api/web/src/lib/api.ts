import { markLoggedOut, type Permissions } from './session.svelte';
import { showToast } from './ui.svelte';

export type { Permissions };

async function request(path: string, opts: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    });
  } catch {
    showToast("Couldn't reach the server - check your connection", 'error');
    throw new Error('network error');
  }
  if (res.status === 401) {
    markLoggedOut();
    throw new Error('unauthorized');
  }
  return res;
}

export async function apiJson<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await request(path, opts);
  return (await res.json()) as T;
}

export async function apiAction<T = Record<string, unknown>>(
  path: string,
  opts: RequestInit,
  successMsg?: string,
): Promise<{ ok: boolean; data: T }> {
  const res = await request(path, opts);
  let data = {} as T;
  try {
    data = (await res.json()) as T;
  } catch {}
  if (!res.ok) {
    showToast((data as { error?: string }).error ?? `Request failed (${res.status})`, 'error');
    return { ok: false, data };
  }
  if (successMsg) showToast(successMsg, 'success');
  return { ok: true, data };
}

export interface JobTestFlightSummary {
  appId: number;
  buildId: number;
  version: string;
  buildNumber: string;
}

export interface JobSummary {
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: JobTestFlightSummary;
  versionLabel?: string;
  source: 'manual' | 'scheduler';
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: string;
  error?: string;
  sizeBytes?: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  queue?: { position: number; total: number };
  statusUrl: string;
  fileUrl: string;
}

export interface ActiveJob {
  id: string;
  bundleId: string;
  source: 'manual' | 'scheduler';
  status: 'queued' | 'running';
  progress: string;
  versionLabel?: string;
  testflight?: JobTestFlightSummary;
  createdAt: number;
}

export interface SchedulerSettings {
  watchBundleId: string;
  watchAppRepo: string;
  ghDispatchRepo: string;
  ghWorkflowFile: string;
  pollCron: string;
  notifyWebhookUrl: string;
}

export interface AppleAuthAlert {
  suspected: boolean;
  lastError?: string;
  lastErrorAt?: number;
}

export interface OverviewPayload {
  schedulerEnabled: boolean;
  settings: SchedulerSettings;
  appleAuthAlert: AppleAuthAlert;
  lastSchedulerRunAt?: number;
  activeJobs: ActiveJob[];
}

export interface JobHistoryEntry {
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { appId: number; build: TFBuild };
  versionLabel?: string;
  status: 'done' | 'failed';
  error?: string;
  sizeBytes?: number;
  source: 'manual' | 'scheduler';
  createdAt: number;
  startedAt?: number;
  finishedAt: number;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  ownerId: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
  approvedAt?: number;
  lastUsedAt?: number;
  expiresAt?: number;
  hasUnrevealedSecret: boolean;
}

export interface AllowedUser {
  username: string;
  permissions: Permissions;
  addedAt: number;
}

export interface LogEntry {
  ts: number;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
}

export interface AppStoreSearchResult {
  bundleId: string;
  trackId: number;
  trackName: string;
  version: string;
  sellerName: string;
  artworkUrl: string;
  price: number;
}

export function fetchOverview(): Promise<OverviewPayload> {
  return apiJson('/v1/dashboard/overview');
}

export interface DeviceHealth {
  reachable: boolean;
  error?: string;
  testFlightRunning?: boolean;
  darkEnabled?: boolean;
  screenIsOn?: boolean;
  backlightState?: number;
  checkedAt: number;
}

export function fetchDeviceHealth(): Promise<DeviceHealth> {
  return apiJson('/v1/dashboard/device/health');
}

export function fetchJobHistory(offset: number, limit: number): Promise<{ history: JobHistoryEntry[]; total: number }> {
  return apiJson(`/v1/dashboard/jobs?offset=${offset}&limit=${limit}`);
}

export function fetchLogs(): Promise<{ logs: LogEntry[] }> {
  return apiJson('/v1/dashboard/logs');
}

export function fetchJobEta(bundleId: string): Promise<{ avgMs: number | null }> {
  return apiJson(`/v1/dashboard/jobs/eta/${encodeURIComponent(bundleId)}`);
}

export function fetchJobVolume(days = 14): Promise<{ days: { date: string; count: number }[] }> {
  return apiJson(`/v1/dashboard/jobs/volume?days=${days}`);
}

export function searchApps(term: string): Promise<{ results: AppStoreSearchResult[] } | { error: string }> {
  return apiJson(`/v1/dashboard/search?q=${encodeURIComponent(term)}`);
}

export function queueDecrypt(
  bundleId: string,
  externalVersionId?: string,
  versionLabel?: string,
): Promise<{ ok: boolean; data: JobSummary }> {
  return apiAction('/v1/dashboard/decrypt', { method: 'POST', body: JSON.stringify({ bundleId, externalVersionId, versionLabel }) });
}

export interface AppVersionEntry {
  externalVersionId: string;
  isLatest: boolean;
  displayVersion?: string;
  bundleVersion?: string;
  releaseDate?: string;
}

export function fetchAppVersions(bundleId: string): Promise<{ versions: AppVersionEntry[] } | { error: string }> {
  return apiJson(`/v1/dashboard/versions/${encodeURIComponent(bundleId)}`);
}

export function fetchJobStatus(id: string): Promise<JobSummary> {
  return apiJson(`/v1/dashboard/jobs/${id}/status`);
}

export interface TFTrain {
  trainVersion: string;
  buildCount: number;
}

export interface TFBuild {
  id: number;
  bundleId: string;
  cfBundleShortVersion: string;
  cfBundleVersion: string;
  whatsNew?: string;
  releaseDate?: string;
  expiration?: string;
  fileSize?: number;
}

export function fetchTestFlightTrains(appId: number): Promise<{ trains: TFTrain[] } | { error: string }> {
  return apiJson(`/v1/dashboard/testflight/${appId}/trains`);
}

export function fetchTestFlightBuilds(appId: number, trainVersion: string): Promise<{ builds: TFBuild[] } | { error: string }> {
  return apiJson(`/v1/dashboard/testflight/${appId}/builds?trainVersion=${encodeURIComponent(trainVersion)}`);
}

export function queueTestFlightDecrypt(bundleId: string, appId: number, build: TFBuild): Promise<{ ok: boolean; data: JobSummary }> {
  return apiAction('/v1/dashboard/testflight/decrypt', { method: 'POST', body: JSON.stringify({ bundleId, appId, build }) });
}

export function clearAuthAlert(): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/auth-alert/clear', { method: 'POST' }, 'Alert dismissed').then((r) => r.data as { ok: boolean });
}

export function fetchMyKeys(): Promise<{ keys: ApiKeyRecord[] }> {
  return apiJson('/v1/dashboard/keys/mine');
}

export function fetchPendingKeys(): Promise<{ keys: ApiKeyRecord[] }> {
  return apiJson('/v1/dashboard/keys/pending');
}

export function fetchAllKeys(): Promise<{ keys: ApiKeyRecord[] }> {
  return apiJson('/v1/dashboard/keys/all');
}

export function requestKey(name: string, expiresInDays?: number): Promise<{ ok: boolean; data: { key?: string; expiresAt?: number } }> {
  return apiAction('/v1/dashboard/keys/request', { method: 'POST', body: JSON.stringify({ name, expiresInDays }) });
}

export function revealKey(id: string): Promise<{ ok: boolean; data: { key: string } }> {
  return apiAction(`/v1/dashboard/keys/${id}/reveal`, { method: 'POST' });
}

export function regenerateKey(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/keys/${id}/regenerate`, { method: 'POST' }, 'Key regenerated - reveal it to get the new value');
}

export function revokeKey(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/keys/${id}`, { method: 'DELETE' }, 'Key revoked');
}

export function bulkRevokeKeys(ids: string[]): Promise<{ ok: boolean; data: { revoked: string[] } }> {
  return apiAction('/v1/dashboard/keys/bulk-revoke', { method: 'POST', body: JSON.stringify({ ids }) }, 'Keys revoked');
}

export function approveKey(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/keys/${id}/approve`, { method: 'POST' }, 'Key approved');
}

export function denyKey(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/keys/${id}/deny`, { method: 'POST' }, 'Key denied');
}

export function fetchSettings(): Promise<SchedulerSettings> {
  return apiJson('/v1/dashboard/settings');
}

export function saveSettings(patch: Partial<SchedulerSettings>): Promise<{ ok: boolean; data: SchedulerSettings }> {
  return apiAction('/v1/dashboard/settings', { method: 'PUT', body: JSON.stringify(patch) }, 'Settings saved');
}

export function validateCron(expr: string): Promise<{ valid: boolean }> {
  return apiJson(`/v1/dashboard/settings/validate-cron?expr=${encodeURIComponent(expr)}`);
}

export function testWebhook(): Promise<{ ok: boolean; data: { ok: boolean; error?: string } }> {
  return apiAction('/v1/dashboard/settings/test-webhook', { method: 'POST' });
}

export interface TestFlightUpdateCheck {
  appId?: number;
  latestTag?: string;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
}

export interface UpdateCheck {
  itunesVersion?: string;
  normalizedVersion?: string;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
  testflight?: TestFlightUpdateCheck;
}

export function previewDispatch(): Promise<UpdateCheck> {
  return apiJson('/v1/dashboard/settings/preview-dispatch');
}

export function triggerDispatch(): Promise<{ ok: boolean; data: { ok: boolean; error?: string } }> {
  return apiAction('/v1/dashboard/settings/trigger-dispatch', { method: 'POST' });
}

export function fetchUsers(): Promise<{ users: AllowedUser[] }> {
  return apiJson('/v1/dashboard/users');
}

export function addUser(username: string, permissions: Permissions): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/users', { method: 'POST', body: JSON.stringify({ username, permissions }) }, `${username} added`);
}

export function removeUser(username: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/users/${encodeURIComponent(username)}`, { method: 'DELETE' }, `${username} removed`);
}

export function updateUserPermissions(username: string, permissions: Permissions): Promise<{ ok: boolean }> {
  return apiAction(
    `/v1/dashboard/users/${encodeURIComponent(username)}`,
    { method: 'PATCH', body: JSON.stringify({ permissions }) },
    `${username}'s permissions updated`,
  );
}

export interface AppleAuthStatus {
  running: boolean;
  waitingForInput?: boolean;
  success?: boolean;
  log: string;
}

export function fetchAppleAuthStatus(): Promise<AppleAuthStatus> {
  return apiJson('/v1/dashboard/apple-auth/status');
}

export function startAppleAuth(): Promise<{ ok: boolean; data: { error?: string } }> {
  return apiAction('/v1/dashboard/apple-auth/start', { method: 'POST' });
}

export function cancelAppleAuth(): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/apple-auth/cancel', { method: 'POST' });
}

export function submitAppleInput(value: string): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/apple-auth/input', { method: 'POST', body: JSON.stringify({ value }) });
}
