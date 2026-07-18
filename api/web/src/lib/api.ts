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
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error('invalid response from server');
  }
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
  queuedBy?: string;
  priority?: number;
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
  queuedBy?: string;
  priority?: number;
  createdAt: number;
  deviceId?: string;
}

export interface SchedulerSettings {
  notifyWebhookUrl: string;
  notifyFormat: 'embed' | 'plain';
  notifyOnKeyRequest: boolean;
  notifyOnDispatchSuccess: boolean;
  notifyOnDispatchFailure: boolean;
  notifyOnAppleAuthAlert: boolean;
  notifyOnKeyExpiringSoon: boolean;
  notifyOnDeviceOffline: boolean;
  notifyOnDeviceBatteryHot: boolean;
  notifyOnDeviceBatteryLow: boolean;
  notifyOnDiskFull: boolean;
  notifyOnDeviceStorageLow: boolean;
  notifyOnTestFlightBridgeDown: boolean;
  notifyOnJobCompleted: boolean;
  schedulerRetryCount: number;
  deviceOfflineAlertMinutes: number;
  batteryHotAlertC: number;
  batteryLowAlertPercent: number;
  diskFullAlertPercent: number;
  deviceStorageAlertPercent: number;
  testFlightBridgeAlertMinutes: number;
  jobHistoryRetentionDays: number;
}

export interface AppWatch {
  id: string;
  name?: string;
  bundleId: string;
  repo: string;
  ghWorkflowFile: string;
  pollCron: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  schedulable: boolean;
  configIssues: string[];
}

export interface DeviceRecord {
  id: string;
  name: string;
  rootDir: string;
  enabled: boolean;
  isPrimary?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AppleAuthAlert {
  suspected: boolean;
  lastError?: string;
  lastErrorAt?: number;
}

export type SchedulerRunStatus = 'dispatched' | 'succeeded' | 'failed' | 'timed_out';

export interface SchedulerRunOutcome {
  ok: boolean;
  triggered: boolean;
  reason: string;
  runUrl?: string;
  runStatus?: SchedulerRunStatus;
}

export interface SchedulerRunEntry {
  id: string;
  ts: number;
  watchId?: string;
  bundleId?: string;
  appStore: SchedulerRunOutcome;
  testflight: SchedulerRunOutcome;
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface OverviewPayload {
  schedulerEnabled: boolean;
  settings: SchedulerSettings;
  watches: AppWatch[];
  devices: DeviceRecord[];
  appleAuthAlert: AppleAuthAlert;
  lastSchedulerRunAt?: number;
  schedulerRunHistory: SchedulerRunEntry[];
  disk?: DiskUsage;
  activeJobs: ActiveJob[];
}

export interface IpaMetadata {
  bundleVersion?: string;
  shortVersion?: string;
  minOsVersion?: string;
  executable?: string;
}

export interface JobHistoryEntry {
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { appId: number; build: TFBuild };
  versionLabel?: string;
  queuedBy?: string;
  status: 'done' | 'failed';
  error?: string;
  sizeBytes?: number;
  source: 'manual' | 'scheduler';
  createdAt: number;
  startedAt?: number;
  finishedAt: number;
  deviceId?: string;
  ipaMetadata?: IpaMetadata;
  ipaInfoPlist?: Record<string, unknown>;
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
  allowedBundleIds?: string[];
  dailyLimit?: number;
  priority?: number;
}

export interface AllowedUser {
  username: string;
  permissions: Permissions;
  addedAt: number;
  lastActiveAt?: number;
  priority?: number;
}

export interface AuditLogEntry {
  id: string;
  ts: number;
  actor: string;
  action: 'user.add' | 'user.update' | 'user.remove' | 'state.import' | 'settings.update';
  target: string;
  detail?: string;
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
  testFlightBridgeReachable?: boolean;
  darkEnabled?: boolean;
  screenIsOn?: boolean;
  backlightState?: number;
  batteryPercent?: number;
  batteryCharging?: boolean;
  batteryTemperatureC?: number;
  batteryCycleCount?: number;
  batteryHealthPercent?: number;
  batteryDesignCapacityMah?: number;
  batteryMaxCapacityMah?: number;
  storageTotalBytes?: number;
  storageUsedBytes?: number;
  storageFreeBytes?: number;
  storageUsedPercent?: number;
  checkedAt: number;
}

export function fetchDeviceHealth(deviceId: string, force = false): Promise<DeviceHealth> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/health${force ? '?force=true' : ''}`);
}

export interface HourlyHealthBucket {
  hourStart: number;
  reachablePercent: number | null;
}

export function fetchDeviceHealthHistory(deviceId: string, hours = 24): Promise<{ buckets: HourlyHealthBucket[]; uptimePercent: number | null }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/health-history?hours=${hours}`);
}

export interface HourlyBatteryBucket {
  hourStart: number;
  batteryPercent: number | null;
}

export function fetchDeviceBatteryHistory(deviceId: string, hours = 24): Promise<{ buckets: HourlyBatteryBucket[] }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/battery-history?hours=${hours}`);
}

export interface HourlyTemperatureBucket {
  hourStart: number;
  batteryTemperatureC: number | null;
}

export function fetchDeviceTemperatureHistory(deviceId: string, hours = 24): Promise<{ buckets: HourlyTemperatureBucket[] }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/temperature-history?hours=${hours}`);
}

export interface HourlyStorageBucket {
  hourStart: number;
  storageUsedPercent: number | null;
}

export function fetchDeviceStorageHistory(deviceId: string, hours = 24): Promise<{ buckets: HourlyStorageBucket[] }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/storage-history?hours=${hours}`);
}

export function fetchDevices(): Promise<{ devices: DeviceRecord[] }> {
  return apiJson('/v1/dashboard/devices');
}

export function createDevice(name: string, rootDir: string): Promise<{ ok: boolean; data: DeviceRecord }> {
  return apiAction('/v1/dashboard/devices', { method: 'POST', body: JSON.stringify({ name, rootDir }) }, 'Device added');
}

export function updateDevice(id: string, patch: Partial<Pick<DeviceRecord, 'name' | 'rootDir' | 'enabled' | 'isPrimary'>>): Promise<{ ok: boolean; data: DeviceRecord }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Device updated');
}

export function deleteDevice(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Device removed');
}

export function fetchWatches(): Promise<{ watches: AppWatch[] }> {
  return apiJson('/v1/dashboard/watches');
}

export interface WatchInput {
  name?: string;
  bundleId: string;
  repo: string;
  ghWorkflowFile: string;
  pollCron: string;
  enabled?: boolean;
}

export function createWatch(input: WatchInput): Promise<{ ok: boolean; data: AppWatch }> {
  return apiAction('/v1/dashboard/watches', { method: 'POST', body: JSON.stringify(input) }, 'Watch added');
}

export function updateWatch(id: string, patch: Partial<WatchInput>): Promise<{ ok: boolean; data: AppWatch }> {
  return apiAction(`/v1/dashboard/watches/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Watch updated');
}

export function deleteWatch(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/watches/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Watch removed');
}

export function previewWatchDispatch(id: string): Promise<UpdateCheck> {
  return apiJson(`/v1/dashboard/watches/${encodeURIComponent(id)}/preview-dispatch`);
}

export function triggerWatchDispatch(id: string): Promise<{ ok: boolean; data: { ok: boolean; error?: string } }> {
  return apiAction(`/v1/dashboard/watches/${encodeURIComponent(id)}/trigger-dispatch`, { method: 'POST' });
}

export interface WebhookDeliveryEntry {
  id: string;
  ts: number;
  kind: 'scheduler' | 'job';
  event: string;
  targetHost: string;
  ok: boolean;
  status?: number;
  error?: string;
  durationMs: number;
}

export function fetchWebhookDeliveries(limit = 100): Promise<{ deliveries: WebhookDeliveryEntry[] }> {
  return apiJson(`/v1/dashboard/webhooks?limit=${limit}`);
}

export interface JobDiffSide {
  id: string;
  versionLabel?: string;
  sizeBytes?: number;
  finishedAt: number;
  metadata?: IpaMetadata;
}

export interface JobDiffResult {
  a: JobDiffSide;
  b: JobDiffSide;
  sizeDeltaBytes: number;
  plistDiff: { key: string; before: unknown; after: unknown }[];
}

export function fetchJobDiff(bundleId: string, a: string, b: string): Promise<JobDiffResult> {
  return apiJson(`/v1/dashboard/jobs/diff?bundleId=${encodeURIComponent(bundleId)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
}

export function fetchJobHistory(
  offset: number,
  limit: number,
  q?: string,
  source?: 'manual' | 'scheduler',
  status?: 'done' | 'failed',
): Promise<{ history: JobHistoryEntry[]; total: number }> {
  const query = q ? `&q=${encodeURIComponent(q)}` : '';
  const sourceQuery = source ? `&source=${source}` : '';
  const statusQuery = status ? `&status=${status}` : '';
  return apiJson(`/v1/dashboard/jobs?offset=${offset}&limit=${limit}${query}${sourceQuery}${statusQuery}`);
}

export interface BundleStats {
  bundleId: string;
  totalRuns: number;
  doneCount: number;
  failedCount: number;
  successRate: number;
  avgDurationMs?: number;
  lastRunAt?: number;
  failureBreakdown: { category: string; count: number }[];
}

export function fetchBundleStats(bundleId: string): Promise<BundleStats> {
  return apiJson(`/v1/dashboard/jobs/stats/${encodeURIComponent(bundleId)}`);
}

export function shareJobFile(id: string, ttlMinutes?: number): Promise<{ ok: boolean; data: { url: string; expiresAt: number } }> {
  return apiAction(`/v1/dashboard/jobs/${id}/share`, { method: 'POST', body: JSON.stringify({ ttlMinutes }) });
}

export interface ShareLinkRecord {
  id: string;
  jobId: string;
  bundleId: string;
  issuedBy: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

export function fetchShareLinks(jobId: string): Promise<{ links: ShareLinkRecord[] }> {
  return apiJson(`/v1/dashboard/jobs/${jobId}/share`);
}

export function revokeShareLink(linkId: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/jobs/share/${linkId}/revoke`, { method: 'POST' }, 'Link revoked').then((r) => ({ ok: r.ok }));
}

export function cancelJob(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/jobs/${id}/cancel`, { method: 'POST' }, 'Cancelled').then((r) => ({ ok: r.ok }));
}

export function prioritizeJob(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/jobs/${id}/prioritize`, { method: 'POST' }, 'Moved to front of queue').then((r) => ({ ok: r.ok }));
}

export interface ApiKeyUsageBucket {
  date: string;
  count: number;
}

export function fetchKeyUsage(id: string, days = 14): Promise<{ usage: ApiKeyUsageBucket[] }> {
  return apiJson(`/v1/dashboard/keys/${id}/usage?days=${days}`);
}

export interface ApiKeyBundleUsage {
  bundleId: string;
  count: number;
}

export function fetchKeyBundleUsage(id: string, limit = 10): Promise<{ bundles: ApiKeyBundleUsage[] }> {
  return apiJson(`/v1/dashboard/keys/${id}/bundle-usage?limit=${limit}`);
}

export function fetchLogs(): Promise<{ logs: LogEntry[] }> {
  return apiJson('/v1/dashboard/logs');
}

export function jobHistoryExportUrl(format: 'csv' | 'json'): string {
  return `/v1/dashboard/jobs/export?format=${format}`;
}

export function fetchJobEta(bundleId: string): Promise<{ avgMs: number | null }> {
  return apiJson(`/v1/dashboard/jobs/eta/${encodeURIComponent(bundleId)}`);
}

export function fetchJobVolume(days = 14): Promise<{ days: { date: string; count: number }[] }> {
  return apiJson(`/v1/dashboard/jobs/volume?days=${days}`);
}

export interface InsightsAppStats {
  bundleId: string;
  totalRuns: number;
  doneCount: number;
  failedCount: number;
  successRate: number;
  totalSizeBytes: number;
}

export interface InsightsSummary {
  totalRuns: number;
  doneCount: number;
  failedCount: number;
  successRate: number;
  totalSizeBytes: number;
  manualCount: number;
  schedulerCount: number;
  topApps: InsightsAppStats[];
  trend: { date: string; count: number }[];
  failureBreakdown: { category: string; count: number }[];
}

export function fetchInsights(trendDays = 14, topApps = 5): Promise<InsightsSummary> {
  return apiJson(`/v1/dashboard/insights?trendDays=${trendDays}&topApps=${topApps}`);
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

export function fetchAppVersions(bundleId: string, force = false): Promise<{ versions: AppVersionEntry[] } | { error: string }> {
  return apiJson(`/v1/dashboard/versions/${encodeURIComponent(bundleId)}${force ? '?force=true' : ''}`);
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

export function fetchAllKeys(offset = 0, limit = 25, search?: string): Promise<{ keys: ApiKeyRecord[]; total: number }> {
  const q = search?.trim() ? `&search=${encodeURIComponent(search.trim())}` : '';
  return apiJson(`/v1/dashboard/keys/all?offset=${offset}&limit=${limit}${q}`);
}

export function requestKey(
  name: string,
  expiresInDays?: number,
  allowedBundleIds?: string[],
  dailyLimit?: number,
): Promise<{ ok: boolean; data: { key?: string; expiresAt?: number } }> {
  return apiAction('/v1/dashboard/keys/request', {
    method: 'POST',
    body: JSON.stringify({ name, expiresInDays, allowedBundleIds, dailyLimit }),
  });
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

export function bulkExtendKeyExpiry(ids: string[], days: number): Promise<{ ok: boolean; data: { extended: string[] } }> {
  return apiAction('/v1/dashboard/keys/bulk-extend-expiry', { method: 'POST', body: JSON.stringify({ ids, days }) }, 'Expiry extended');
}

export function bulkSetKeyDailyLimit(ids: string[], dailyLimit: number | null): Promise<{ ok: boolean; data: { updated: string[] } }> {
  return apiAction('/v1/dashboard/keys/bulk-set-daily-limit', { method: 'POST', body: JSON.stringify({ ids, dailyLimit }) }, 'Daily limit updated');
}

export function approveKey(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/keys/${id}/approve`, { method: 'POST' }, 'Key approved');
}

export function bulkApproveKeys(ids: string[]): Promise<{ ok: boolean; data: { approved: string[] } }> {
  return apiAction('/v1/dashboard/keys/bulk-approve', { method: 'POST', body: JSON.stringify({ ids }) }, 'Keys approved');
}

export function denyKey(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/keys/${id}/deny`, { method: 'POST' }, 'Key denied');
}

export function updateKeyPriority(id: string, priority: number): Promise<{ ok: boolean; data: { priority?: number } }> {
  return apiAction(`/v1/dashboard/keys/${id}/priority`, { method: 'PATCH', body: JSON.stringify({ priority }) }, 'Priority updated');
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

export function testWebhook(url?: string): Promise<{ ok: boolean; data: { ok: boolean; error?: string } }> {
  return apiAction('/v1/dashboard/settings/test-webhook', { method: 'POST', body: JSON.stringify({ url }) });
}

export interface TestFlightUpdateCheck {
  ok: boolean;
  appId?: number;
  latestTag?: string;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
}

export interface UpdateCheck {
  ok: boolean;
  itunesVersion?: string;
  normalizedVersion?: string;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
  testflight?: TestFlightUpdateCheck;
}

export function fetchUsers(): Promise<{ users: AllowedUser[] }> {
  return apiJson('/v1/dashboard/users');
}

export function fetchAuditLog(limit = 100): Promise<{ entries: AuditLogEntry[] }> {
  return apiJson(`/v1/dashboard/audit-log?limit=${limit}`);
}

export function addUser(username: string, permissions: Permissions): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/users', { method: 'POST', body: JSON.stringify({ username, permissions }) }, `${username} added`);
}

export function removeUser(username: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/users/${encodeURIComponent(username)}`, { method: 'DELETE' }, `${username} removed`);
}

export function updateUserPermissions(username: string, permissions: Permissions, priority?: number): Promise<{ ok: boolean }> {
  return apiAction(
    `/v1/dashboard/users/${encodeURIComponent(username)}`,
    { method: 'PATCH', body: JSON.stringify({ permissions, priority }) },
    `${username}'s permissions updated`,
  );
}

export function backupExportUrl(): string {
  return '/v1/dashboard/backup/export';
}

export function importBackup(payload: unknown): Promise<{ ok: boolean; data: { error?: string } }> {
  return apiAction('/v1/dashboard/backup/import', { method: 'POST', body: JSON.stringify(payload) }, 'Backup restored');
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

export function fetchPushPublicKey(): Promise<{ publicKey: string }> {
  return apiJson('/v1/dashboard/push/public-key');
}

export function subscribePush(subscription: PushSubscriptionJSON): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }).then((r) => ({ ok: r.ok }));
}

export function unsubscribePush(endpoint: string): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }).then((r) => ({ ok: r.ok }));
}

export function testPush(): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/push/test', { method: 'POST' }, 'Test push sent').then((r) => ({ ok: r.ok }));
}

export function submitAppleInput(value: string): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/apple-auth/input', { method: 'POST', body: JSON.stringify({ value }) });
}
