import { markLoggedOut, type Role } from '#lib/session.svelte';
import { liveState } from '#lib/live.svelte';
import { rateLimitState } from '#lib/rateLimit.svelte';
import { showToast } from '#lib/ui.svelte';

export type { Role };
export { rateLimitState, type RateLimitInfo } from '#lib/rateLimit.svelte';

function captureRateLimitHeaders(bucket: string | undefined, res: Response): void {
  if (!bucket) return;
  const limit = res.headers.get('X-RateLimit-Limit');
  const remaining = res.headers.get('X-RateLimit-Remaining');
  const reset = res.headers.get('X-RateLimit-Reset');
  if (limit === null || remaining === null || reset === null) return;
  rateLimitState[bucket] = { limit: Number(limit), remaining: Number(remaining), resetAt: Number(reset) * 1000 };
}

async function request(path: string, opts: RequestInit = {}, bucket?: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    });
  } catch {
    showToast("Couldn't reach the server - check your connection", 'error', { id: 'network-error', track: false });
    throw new Error('network error');
  }
  captureRateLimitHeaders(bucket, res);
  if (res.status === 401) {
    markLoggedOut();
    throw new Error('unauthorized');
  }
  return res;
}

export async function apiJson<T>(path: string, opts?: RequestInit, bucket?: string): Promise<T> {
  const res = await request(path, opts, bucket);
  let data: T | { error?: string };
  try {
    data = (await res.json()) as T;
  } catch {
    throw new Error('invalid response from server');
  }
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export async function apiAction<T = Record<string, unknown>>(
  path: string,
  opts: RequestInit,
  successMsg?: string,
): Promise<{ ok: boolean; data: T }> {
  const method = String(opts.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && liveState.overview !== null && !liveState.connected) {
    showToast('Live connection is down - reconnect before making changes', 'error');
    return { ok: false, data: {} as T };
  }

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
  fileExpiresAt?: string;
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
  notifySuccessMode: 'instant' | 'daily' | 'weekly';
  notifyQuietHoursStart: string;
  notifyQuietHoursEnd: string;
  notifyOnKeyRequest: boolean;
  notifyOnAutomationSuccess: boolean;
  notifyOnAutomationFailure: boolean;
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
  maintenanceMode: boolean;
}

export interface MaintenanceStatus {
  active: boolean;
  manual: boolean;
  auto: boolean;
  reason?: string;
}

export interface AppWatch {
  id: string;
  bundleId: string;
  repo: string;
  ghWorkflowFile: string;
  dispatchTargets?: DispatchTarget[];
  pollCron: string;
  enabled: boolean;
  webhookUrl?: string;
  testFlightPolicy?: 'latest' | 'latestNonExpired' | 'train';
  testFlightTrain?: string;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  schedulable: boolean;
  configIssues: string[];
}

export interface DispatchTarget {
  repo: string;
  ghWorkflowFile: string;
  mode?: 'repository_dispatch' | 'workflow_dispatch';
  ref?: string;
  inputs?: Record<string, string>;
}

export interface DeviceRecord {
  id: string;
  name: string;
  rootDir: string;
  iosVersion?: string;
  toolchain?: string;
  notes?: string;
  enabled: boolean;
  isPrimary?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DevicePreflight {
  device: DeviceRecord;
  health: DeviceHealth;
  bridge?: TestFlightBridgeDiagnostics;
  ready: boolean;
  checks: Array<{ label: string; ok: boolean; detail?: string }>;
}

export type SchedulerRunStatus = 'dispatched' | 'succeeded' | 'failed' | 'timed_out';

export interface SchedulerRunOutcome {
  ok: boolean;
  triggered: boolean;
  reason: string;
  runUrl?: string;
  runStatus?: SchedulerRunStatus;
  observedVersion?: string;
  installMode?: 'pinned' | 'current';
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
  lastSchedulerRunAt?: number;
  schedulerRunHistory: SchedulerRunEntry[];
  disk?: DiskUsage;
  isPaidPlan?: boolean;
  maintenance?: MaintenanceStatus;
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
  activeShareUrl?: string;
}

export interface JobTimelineEvent {
  at: number;
  label: string;
  status: 'queued' | 'running' | 'done' | 'failed';
}

export interface JobTimeline {
  id: string;
  correlationId: string;
  bundleId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  events: JobTimelineEvent[];
  guidance?: { category: string; title: string; action: string; retryRecommended: boolean };
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  ownerId: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
  approvedAt?: number;
  lastUsedAt?: number;
  lastUsedIp?: string;
  expiresAt?: number;
  hasUnrevealedSecret: boolean;
  allowedBundleIds?: string[];
  dailyLimit?: number;
  maxConcurrent?: number;
  allowTestFlight?: boolean;
  priority?: number;
  previousKeyValidUntil?: number;
}

export interface AllowedUser {
  username: string;
  displayName?: string;
  avatarUrl?: string;
  roleIds: string[];
  addedAt: number;
  lastActiveAt?: number;
  priority?: number;
}

export interface AuditLogEntry {
  id: string;
  ts: number;
  actor: string;
  action:
    | 'user.add'
    | 'user.update'
    | 'user.remove'
    | 'state.import'
    | 'settings.update'
    | 'watch.add'
    | 'watch.update'
    | 'watch.remove'
    | 'device.add'
    | 'device.update'
    | 'device.remove'
    | 'role.add'
    | 'role.update'
    | 'role.remove';
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
  category?: string;
}

export interface AppCatalogEntry {
  bundleId: string;
  displayName: string;
  iconUrl?: string;
  trackId?: number;
  sellerName?: string;
  category?: string;
  description?: string;
  screenshots?: string[];
  releaseNotes?: string;
  price?: number;
  updatedAt: number;
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
  networkConnected?: boolean;
  internetAccess?: boolean;
  networkIpAddress?: string;
  networkInterface?: string;
  bridgeHeartbeats?: Partial<Record<'springboard' | 'testflight' | 'appstore', { bridgeVersion?: string; channel?: string; process?: string; at?: number }>>;
  readiness?: DeviceReadiness;
  checkedAt: number;
}

export interface DeviceReadiness {
  score: number;
  state: 'ready' | 'caution' | 'blocked';
  reasons: string[];
}

export interface DeviceActivityEntry {
  id: string;
  ts: number;
  deviceId: string;
  kind: 'health' | 'bridge' | 'job';
  message: string;
  bundleId?: string;
}

export function fetchDeviceHealth(deviceId: string, force = false): Promise<DeviceHealth> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/health${force ? '?force=true' : ''}`);
}

export function fetchDevicePreflight(deviceId: string): Promise<DevicePreflight> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/preflight`, undefined, 'external');
}

export function fetchDeviceInventory(deviceId: string): Promise<{ deviceId: string; bundles: string[] }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/inventory`, undefined, 'external');
}

export interface HourlyHealthBucket {
  hourStart: number;
  reachablePercent: number | null;
}

export function fetchDeviceHealthHistory(deviceId: string, hours = 24): Promise<{ buckets: HourlyHealthBucket[]; uptimePercent: number | null }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/health-history?hours=${hours}`);
}

export function fetchDeviceActivity(deviceId: string, limit = 12): Promise<{ activity: DeviceActivityEntry[] }> {
  return apiJson(`/v1/dashboard/devices/${encodeURIComponent(deviceId)}/activity?limit=${limit}`);
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

export function createDevice(name: string, rootDir: string, profile?: Pick<DeviceRecord, 'iosVersion' | 'toolchain' | 'notes'>): Promise<{ ok: boolean; data: DeviceRecord }> {
  return apiAction('/v1/dashboard/devices', { method: 'POST', body: JSON.stringify({ name, rootDir, ...profile }) }, 'Device added');
}

export function updateDevice(id: string, patch: Partial<Pick<DeviceRecord, 'name' | 'rootDir' | 'iosVersion' | 'toolchain' | 'notes' | 'enabled' | 'isPrimary'>>): Promise<{ ok: boolean; data: DeviceRecord }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Device updated');
}

export function deleteDevice(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Device removed');
}

export function setDeviceDarkMode(id: string, enabled: boolean): Promise<{ ok: boolean; data: DeviceHealth }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}/dark-mode`, { method: 'PUT', body: JSON.stringify({ enabled }) }, enabled ? 'Display dark mode enabled' : 'Display dark mode disabled');
}

export function runBridgeAction(id: string, action: 'open-testflight' | 'open-appstore' | 'screen-status'): Promise<{ ok: boolean; data: { result: Record<string, unknown> } }> {
  return apiAction(`/v1/dashboard/devices/${encodeURIComponent(id)}/bridge-action`, { method: 'POST', body: JSON.stringify({ action }) }, 'Bridge action completed');
}

export function fetchWatches(): Promise<{ watches: AppWatch[] }> {
  return apiJson('/v1/dashboard/watches');
}

export interface WatchInput {
  bundleId: string;
  repo: string;
  ghWorkflowFile: string;
  dispatchTargets?: DispatchTarget[];
  pollCron: string;
  enabled?: boolean;
  webhookUrl?: string;
  testFlightPolicy?: 'latest' | 'latestNonExpired' | 'train';
  testFlightTrain?: string;
}

export interface GithubRepoOption {
  fullName: string;
  isPrivate: boolean;
  defaultBranch: string;
}

export interface GithubWorkflowOption {
  id: number;
  name: string;
  path: string;
  state: string;
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

export function importWatches(watches: WatchInput[]): Promise<{ ok: boolean; data: { watches: AppWatch[]; skipped: string[] } }> {
  return apiAction('/v1/dashboard/watches/import', { method: 'POST', body: JSON.stringify({ watches }) }, 'Watches imported');
}

export function watchesExportUrl(): string {
  return '/v1/dashboard/watches/export';
}

export function previewWatchDispatch(id: string): Promise<UpdateCheck> {
  return apiJson(`/v1/dashboard/watches/${encodeURIComponent(id)}/preview-dispatch`, undefined, 'external');
}

export interface PreviewSourceResult {
  source: 'appStore' | 'testflight';
  result: UpdateCheck | TestFlightUpdateCheck;
}

export function previewWatchDispatchSource(id: string, source: 'app-store' | 'testflight'): Promise<PreviewSourceResult> {
  return apiJson(`/v1/dashboard/watches/${encodeURIComponent(id)}/preview-dispatch/${source}`, undefined, 'external');
}

export function previewWatchDispatchDraft(bundleId: string, repo: string): Promise<UpdateCheck> {
  return apiJson(
    '/v1/dashboard/watches/preview-dispatch-draft',
    { method: 'POST', body: JSON.stringify({ bundleId, repo }) },
    'external',
  );
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
  return apiJson(
    `/v1/dashboard/jobs/diff?bundleId=${encodeURIComponent(bundleId)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
    undefined,
    'jobDiff',
  );
}

export function fetchJobHistory(
  offset: number,
  limit: number,
  q?: string,
  source?: 'manual' | 'scheduler',
  status?: 'done' | 'failed',
  opts?: { queuedBy?: string; deviceId?: string; errorQ?: string; failureCategory?: string; fromTs?: number; toTs?: number },
): Promise<{ history: JobHistoryEntry[]; total: number }> {
  const query = q ? `&q=${encodeURIComponent(q)}` : '';
  const sourceQuery = source ? `&source=${source}` : '';
  const statusQuery = status ? `&status=${status}` : '';
  const queuedByQuery = opts?.queuedBy ? `&queuedBy=${encodeURIComponent(opts.queuedBy)}` : '';
  const deviceIdQuery = opts?.deviceId ? `&deviceId=${encodeURIComponent(opts.deviceId)}` : '';
  const errorQuery = opts?.errorQ ? `&errorQ=${encodeURIComponent(opts.errorQ)}` : '';
  const failureCategoryQuery = opts?.failureCategory ? `&failureCategory=${encodeURIComponent(opts.failureCategory)}` : '';
  const fromTsQuery = Number.isFinite(opts?.fromTs) ? `&fromTs=${opts?.fromTs}` : '';
  const toTsQuery = Number.isFinite(opts?.toTs) ? `&toTs=${opts?.toTs}` : '';
  return apiJson(
    `/v1/dashboard/jobs?offset=${offset}&limit=${limit}${query}${sourceQuery}${statusQuery}${queuedByQuery}${deviceIdQuery}${errorQuery}${failureCategoryQuery}${fromTsQuery}${toTsQuery}`,
  );
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

export function shareJobFile(
  id: string,
  ttlMinutes?: number,
  maxDownloads?: number,
): Promise<{ ok: boolean; data: { url: string; expiresAt: number; maxDownloads?: number } }> {
  return apiAction(`/v1/dashboard/jobs/${id}/share`, { method: 'POST', body: JSON.stringify({ ttlMinutes, maxDownloads }) });
}

export interface ShareLinkRecord {
  id: string;
  jobId: string;
  bundleId: string;
  issuedBy: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
  maxDownloads?: number;
  downloadCount: number;
  usedAt?: number;
  lastUsedAt?: number;
  url?: string;
}

export function fetchShareLinks(jobId: string): Promise<{ links: ShareLinkRecord[] }> {
  return apiJson(`/v1/dashboard/jobs/${jobId}/share`);
}

export function fetchAllShareLinks(): Promise<{ links: ShareLinkRecord[] }> {
  return apiJson('/v1/dashboard/share-links');
}

export function shareLinksExportUrl(format: 'csv' | 'json'): string {
  return `/v1/dashboard/share-links/export?format=${format}`;
}

export function revokeShareLink(linkId: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/jobs/share/${linkId}/revoke`, { method: 'POST' }, 'Link revoked').then((r) => ({ ok: r.ok }));
}

export function revokeAllShareLinks(jobId: string): Promise<{ ok: boolean; data: { revoked: number } }> {
  return apiAction(`/v1/dashboard/jobs/${jobId}/share/revoke-all`, { method: 'POST' }, 'Active links revoked');
}

export function updateShareLink(
  linkId: string,
  updates: { ttlMinutes?: number; maxDownloads?: number | null },
): Promise<{ ok: boolean; data: { link?: ShareLinkRecord } }> {
  return apiAction(`/v1/dashboard/jobs/share/${linkId}`, { method: 'PATCH', body: JSON.stringify(updates) }, 'Link updated');
}

export function cancelJob(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/jobs/${id}/cancel`, { method: 'POST' }, 'Cancelled').then((r) => ({ ok: r.ok }));
}

export function prioritizeJob(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/jobs/${id}/prioritize`, { method: 'POST' }, 'Moved to front of queue').then((r) => ({ ok: r.ok }));
}

export function reorderQueue(ids: string[]): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/jobs/reorder', { method: 'POST', body: JSON.stringify({ ids }) }).then((r) => ({ ok: r.ok }));
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
  avgDurationMs?: number;
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
  byDevice: DeviceThroughputStats[];
}

export interface DeviceThroughputStats {
  deviceId: string;
  deviceName: string;
  removed: boolean;
  totalRuns: number;
  doneCount: number;
  failedCount: number;
  successRate: number;
  totalSizeBytes: number;
  avgDurationMs?: number;
}

export function fetchInsights(trendDays = 14, topApps = 5): Promise<InsightsSummary> {
  return apiJson(`/v1/dashboard/insights?trendDays=${trendDays}&topApps=${topApps}`);
}

export interface FailurePattern {
  message: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  bundleIds: string[];
}

export function fetchFailurePatterns(): Promise<{ patterns: FailurePattern[] }> {
  return apiJson('/v1/dashboard/failure-patterns');
}

export interface StorageForecast {
  freeBytes: number;
  bytesPerDay: number;
  daysRemaining: number | null;
  sampleCount: number;
}

export function fetchStorageForecast(): Promise<StorageForecast> {
  return apiJson('/v1/dashboard/storage-forecast');
}

export function supportBundleUrl(): string {
  return '/v1/dashboard/support-bundle';
}

export interface WatchHealthSummary {
  watchId: string;
  bundleId: string;
  schedulable: boolean;
  dispatchTargetCount: number;
  lastCheckAt?: number;
  lastCheckOk?: boolean;
  consecutiveFailures: number;
  everTriggeredInHistory: boolean;
  historyCount: number;
  schedulerJobCount: number;
  schedulerJobSuccessRate?: number;
  medianSchedulerJobDurationMs?: number;
}

export function fetchWatchHealth(): Promise<{ watches: WatchHealthSummary[] }> {
  return apiJson('/v1/dashboard/watches/health');
}

export function fetchGithubRepos(): Promise<{ repos: GithubRepoOption[] }> {
  return apiJson('/v1/dashboard/github/repos');
}

export function fetchGithubWorkflows(repo: string): Promise<{ workflows: GithubWorkflowOption[] }> {
  return apiJson(`/v1/dashboard/github/workflows?repo=${encodeURIComponent(repo)}`);
}

export interface GithubRateLimit {
  limit?: number;
  remaining?: number;
  reset?: number;
}

export function fetchGithubRateLimit(): Promise<GithubRateLimit> {
  return apiJson('/v1/dashboard/github/rate-limit');
}

export function searchApps(term: string): Promise<{ results: AppStoreSearchResult[] } | { error: string }> {
  return apiJson(`/v1/dashboard/search?q=${encodeURIComponent(term)}`);
}

export function fetchAppCatalog(bundleIds: string[]): Promise<{ entries: AppCatalogEntry[] }> {
  const unique = [...new Set(bundleIds.map((bundleId) => bundleId.trim()).filter(Boolean))];
  if (unique.length === 0) return Promise.resolve({ entries: [] });
  return apiJson(`/v1/dashboard/apps/metadata?bundleIds=${encodeURIComponent(unique.join(','))}`);
}

export function refreshAppCatalog(bundleIds: string[]): Promise<{ ok: boolean; data: { entries: AppCatalogEntry[] } }> {
  return apiAction('/v1/dashboard/apps/metadata/refresh', {
    method: 'POST',
    body: JSON.stringify({ bundleIds }),
  });
}

export interface AppCatalogStats {
  entries: number;
  icons: number;
  oldestUpdatedAt?: number;
  newestUpdatedAt?: number;
}

export function fetchAppCatalogStats(): Promise<AppCatalogStats> {
  return apiJson('/v1/dashboard/apps/cache');
}

export function queueDecrypt(
  bundleId: string,
  externalVersionId?: string,
  versionLabel?: string,
  preferPrimary = false,
): Promise<{ ok: boolean; data: JobSummary }> {
  return apiAction('/v1/dashboard/decrypt', {
    method: 'POST',
    body: JSON.stringify({ bundleId, externalVersionId, versionLabel, preferPrimary }),
  });
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

export interface TestFlightBridgeDiagnostics {
  bridge: {
    bridgeVersion?: string;
    capabilities?: string[];
    hasInstaller?: boolean;
    hasCatalogManager?: boolean;
    backgroundTaskActive?: boolean;
    backgroundTimeRemaining?: number;
  };
  install?: Record<string, unknown>;
  recentLog?: string[];
}

export function fetchTestFlightBridgeDiagnostics(): Promise<TestFlightBridgeDiagnostics> {
  return apiJson('/v1/dashboard/testflight/diagnostics', undefined, 'external');
}

export function fetchTestFlightTrains(appId: number): Promise<{ trains: TFTrain[] } | { error: string }> {
  return apiJson(`/v1/dashboard/testflight/${appId}/trains`, undefined, 'external');
}

export function fetchTestFlightBuilds(appId: number, trainVersion: string): Promise<{ builds: TFBuild[] } | { error: string }> {
  return apiJson(`/v1/dashboard/testflight/${appId}/builds?trainVersion=${encodeURIComponent(trainVersion)}`, undefined, 'external');
}

export function queueTestFlightDecrypt(
  bundleId: string,
  appId: number,
  build: TFBuild,
  preferPrimary = false,
): Promise<{ ok: boolean; data: JobSummary }> {
  return apiAction('/v1/dashboard/testflight/decrypt', { method: 'POST', body: JSON.stringify({ bundleId, appId, build, preferPrimary }) });
}

export function retryJob(id: string, preferPrimary = false): Promise<{ ok: boolean; data: JobSummary }> {
  return apiAction(`/v1/dashboard/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ preferPrimary }) });
}

export function fetchJobTimeline(id: string): Promise<JobTimeline> {
  return apiJson(`/v1/dashboard/jobs/${encodeURIComponent(id)}/timeline`);
}

export function jobDiagnosticUrl(id: string): string {
  return `/v1/dashboard/jobs/${encodeURIComponent(id)}/diagnostic`;
}

export function regenerateWorkflowHandoff(id: string): Promise<{ ok: boolean; data: { url: string; expiresAt: number } }> {
  return apiAction(`/v1/dashboard/jobs/${encodeURIComponent(id)}/handoff`, { method: 'POST' });
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

export function createKey(
  name: string,
  expiresInDays?: number,
  allowedBundleIds?: string[],
  dailyLimit?: number,
): Promise<{ ok: boolean; data: { key?: string; expiresAt?: number } }> {
  return apiAction('/v1/dashboard/keys/create', {
    method: 'POST',
    body: JSON.stringify({ name, expiresInDays, allowedBundleIds, dailyLimit }),
  });
}

export function revealKey(id: string): Promise<{ ok: boolean; data: { key: string } }> {
  return apiAction(`/v1/dashboard/keys/${id}/reveal`, { method: 'POST' });
}

export function regenerateKey(id: string, graceMinutes = 0): Promise<{ ok: boolean; data: { key?: ApiKeyRecord } }> {
  return apiAction(
    `/v1/dashboard/keys/${id}/regenerate`,
    { method: 'POST', body: JSON.stringify({ graceMinutes }) },
    graceMinutes > 0 ? `Key regenerated - old secret still works for ${graceMinutes}m` : 'Key regenerated - reveal it to get the new value',
  );
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

export function bulkSetKeyScope(ids: string[], allowedBundleIds: string[] | null): Promise<{ ok: boolean; data: { updated: string[] } }> {
  return apiAction('/v1/dashboard/keys/bulk-set-scope', { method: 'POST', body: JSON.stringify({ ids, allowedBundleIds }) }, 'Scope updated');
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

export function updateKeyMaxConcurrent(id: string, maxConcurrent: number | null): Promise<{ ok: boolean; data: { maxConcurrent?: number } }> {
  return apiAction(`/v1/dashboard/keys/${id}/max-concurrent`, { method: 'PATCH', body: JSON.stringify({ maxConcurrent }) }, 'Concurrency cap updated');
}

export function updateKeyAllowTestFlight(id: string, allowTestFlight: boolean): Promise<{ ok: boolean; data: { allowTestFlight?: boolean } }> {
  return apiAction(
    `/v1/dashboard/keys/${id}/allow-testflight`,
    { method: 'PATCH', body: JSON.stringify({ allowTestFlight }) },
    allowTestFlight ? 'TestFlight access enabled for this key' : 'TestFlight access disabled for this key',
  );
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

export function auditLogExportUrl(format: 'csv' | 'json'): string {
  return `/v1/dashboard/audit-log/export?format=${format}`;
}

export function fetchRoles(): Promise<{ roles: Role[] }> {
  return apiJson('/v1/dashboard/roles');
}

export function addUser(username: string, roleIds: string[]): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/users', { method: 'POST', body: JSON.stringify({ username, roleIds }) }, `${username} added`);
}

export function removeUser(username: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/users/${encodeURIComponent(username)}`, { method: 'DELETE' }, `${username} removed`);
}

export function updateUserRoles(username: string, roleIds: string[], priority?: number): Promise<{ ok: boolean }> {
  return apiAction(
    `/v1/dashboard/users/${encodeURIComponent(username)}`,
    { method: 'PATCH', body: JSON.stringify({ roleIds, priority }) },
    `${username}'s roles updated`,
  );
}

export function createRole(name: string, color: string, permissions: string): Promise<{ ok: boolean; data: Role }> {
  return apiAction<Role>('/v1/dashboard/roles', { method: 'POST', body: JSON.stringify({ name, color, permissions }) }, `Role "${name}" created`);
}

export function updateRole(id: string, patch: { name?: string; color?: string; permissions?: string }): Promise<{ ok: boolean; data: Role }> {
  return apiAction<Role>(`/v1/dashboard/roles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'Role updated');
}

export function deleteRole(id: string, name: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }, `Role "${name}" deleted`);
}

export function reorderRoles(roleIds: string[]): Promise<{ ok: boolean; data: { roles: Role[] } }> {
  return apiAction<{ roles: Role[] }>('/v1/dashboard/roles/reorder', { method: 'POST', body: JSON.stringify({ roleIds }) }, 'Role order updated');
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
}

export interface DiscordGuildRole {
  id: string;
  name: string;
  color: number;
  position: number;
}

export interface DiscordRolePerk {
  id: string;
  guildId: string;
  guildName?: string;
  guildIcon: string | null;
  discordRoleId: string;
  discordRoleName?: string;
  discordRoleColor: number;
  appRoleId: string;
  createdAt: number;
}

export function fetchDiscordStatus(): Promise<{ botEnabled: boolean; guilds: DiscordGuildSummary[] }> {
  return apiJson('/v1/dashboard/discord/status');
}

export function fetchDiscordGuilds(): Promise<{ guilds: DiscordGuildSummary[] }> {
  return apiJson('/v1/dashboard/discord/guilds');
}

export function setDiscordGuilds(guilds: DiscordGuildSummary[]): Promise<{ ok: boolean; data: { guilds: DiscordGuildSummary[] } }> {
  return apiAction('/v1/dashboard/discord/guilds', { method: 'POST', body: JSON.stringify({ guilds }) }, 'Discord guilds updated');
}

export function fetchDiscordGuildRoles(guildId: string): Promise<{ roles: DiscordGuildRole[] }> {
  return apiJson(`/v1/dashboard/discord/roles?guildId=${encodeURIComponent(guildId)}`);
}

export function fetchDiscordRolePerks(): Promise<{ perks: DiscordRolePerk[] }> {
  return apiJson('/v1/dashboard/discord/perks');
}

export function createDiscordRolePerk(
  guild: DiscordGuildSummary,
  discordRole: DiscordGuildRole,
  appRoleId: string,
): Promise<{ ok: boolean; data: DiscordRolePerk }> {
  return apiAction(
    '/v1/dashboard/discord/perks',
    {
      method: 'POST',
      body: JSON.stringify({
        guildId: guild.id,
        guildName: guild.name,
        guildIcon: guild.icon,
        discordRoleId: discordRole.id,
        discordRoleName: discordRole.name,
        discordRoleColor: discordRole.color,
        appRoleId,
      }),
    },
    'Discord role perk added',
  );
}

export function deleteDiscordRolePerk(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/discord/perks/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Discord role perk removed');
}

export function backupExportUrl(): string {
  return '/v1/dashboard/backup/export';
}

export function importBackup(payload: unknown): Promise<{ ok: boolean; data: { error?: string } }> {
  return apiAction('/v1/dashboard/backup/import', { method: 'POST', body: JSON.stringify(payload) }, 'Backup restored');
}

export interface BackupPreviewSummary {
  exportedAt?: number;
  incoming: { users: number; roles: number; apiKeys: number; watches: number; devices: number; jobHistory: number; auditLog: number };
  current: { users: number; roles: number; apiKeys: number; watches: number; devices: number; jobHistory: number; auditLog: number };
}

export function previewBackup(payload: unknown): Promise<{ ok: boolean; data: BackupPreviewSummary | { error?: string } }> {
  return apiAction('/v1/dashboard/backup/preview', { method: 'POST', body: JSON.stringify(payload) });
}

export interface BackupScheduleSettings {
  enabled: boolean;
  cron: string;
  retentionCount: number;
}

export interface BackupHistoryEntry {
  id: string;
  createdAt: number;
  sizeBytes: number;
  filename: string;
  trigger: 'scheduled' | 'manual';
}

export function fetchBackupSchedule(): Promise<BackupScheduleSettings> {
  return apiJson('/v1/dashboard/backup/schedule');
}

export function updateBackupSchedule(patch: Partial<BackupScheduleSettings>): Promise<{ ok: boolean; data: BackupScheduleSettings }> {
  return apiAction('/v1/dashboard/backup/schedule', { method: 'POST', body: JSON.stringify(patch) }, 'Backup schedule updated');
}

export function fetchBackupHistory(): Promise<BackupHistoryEntry[]> {
  return apiJson('/v1/dashboard/backup/history');
}

export function createBackupSnapshot(): Promise<{ ok: boolean; data: BackupHistoryEntry }> {
  return apiAction('/v1/dashboard/backup/history', { method: 'POST' }, 'Backup snapshot created');
}

export function deleteBackupSnapshot(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/dashboard/backup/history/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Backup snapshot deleted');
}

export function backupSnapshotDownloadUrl(id: string): string {
  return `/v1/dashboard/backup/history/${encodeURIComponent(id)}/download`;
}

export interface ActiveSessionInfo {
  id: string;
  sub: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
  ip?: string;
  current: boolean;
}

export function fetchSessions(): Promise<ActiveSessionInfo[]> {
  return apiJson('/v1/auth/sessions');
}

export function revokeSession(id: string): Promise<{ ok: boolean }> {
  return apiAction(`/v1/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Session signed out');
}

export function revokeOtherSessions(): Promise<{ ok: boolean; data: { revoked: number } }> {
  return apiAction('/v1/auth/sessions/revoke-others', { method: 'POST' }, 'Other sessions signed out');
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

export function testEmail(): Promise<{ ok: boolean }> {
  return apiAction('/v1/dashboard/email/test', { method: 'POST' }, 'Test email sent').then((r) => ({ ok: r.ok }));
}
