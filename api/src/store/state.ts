import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateVAPIDKeys, type VapidKeys } from 'web-push';
import { config } from '../config.js';
import { emitHistoryAdded } from '../events.js';
import type { TestFlightJobSource } from '../jobs/types.js';
import { categorizeFailure } from '../util/failureCategory.js';

export type ApiKeyStatus = 'pending' | 'approved' | 'denied';

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

// Legacy migrations (v1/v2 role strings, v3's 4 flags) always grant viewLogs - the Logs tab
// was unconditionally visible to any authenticated user before it became its own permission.
function legacyRoleToPermissions(role: string): Permissions {
  switch (role) {
    case 'admin':
      return { ...ADMIN_PERMISSIONS };
    case 'operator':
      return { ...VIEWER_PERMISSIONS, decrypt: true, viewApiKeys: true, approveApiKeys: true, revokeApiKeys: true, viewLogs: true };
    case 'member':
      return { ...VIEWER_PERMISSIONS, decrypt: true, viewLogs: true };
    default:
      return { ...VIEWER_PERMISSIONS, viewLogs: true };
  }
}

interface LegacyV3Permissions {
  decrypt: boolean;
  manageKeys: boolean;
  manageSettings: boolean;
  manageUsers: boolean;
}

function migratePermissionsV3(old: LegacyV3Permissions): Permissions {
  return {
    decrypt: old.decrypt,
    viewApiKeys: old.manageKeys,
    approveApiKeys: old.manageKeys,
    revokeApiKeys: old.manageKeys,
    manageScheduler: old.manageSettings,
    triggerDispatch: old.manageSettings,
    manageAppleAuth: old.manageSettings && old.manageUsers,
    viewLogs: true,
    viewUsers: old.manageUsers,
    manageUsers: old.manageUsers,
  };
}

interface LegacyV4Permissions {
  decrypt: boolean;
  viewApiKeys: boolean;
  approveApiKeys: boolean;
  revokeApiKeys: boolean;
  manageScheduler: boolean;
  manageAppleAuth: boolean;
  viewUsers: boolean;
  manageUsers: boolean;
}

// v4 -> v5 split manageScheduler into manageScheduler (config) + triggerDispatch (operate),
// and added viewLogs as its own permission - preserve exactly what v4 already granted.
function migratePermissionsV4(old: LegacyV4Permissions): Permissions {
  return {
    decrypt: old.decrypt,
    viewApiKeys: old.viewApiKeys,
    approveApiKeys: old.approveApiKeys,
    revokeApiKeys: old.revokeApiKeys,
    manageScheduler: old.manageScheduler,
    triggerDispatch: old.manageScheduler,
    manageAppleAuth: old.manageAppleAuth,
    viewLogs: true,
    viewUsers: old.viewUsers,
    manageUsers: old.manageUsers,
  };
}

export interface AllowedUser {
  username: string;
  permissions: Permissions;
  addedAt: number;
  sessionVersion?: number;
  lastActiveAt?: number;
  priority?: number;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  ownerId: string;
  status: ApiKeyStatus;
  hash?: string;
  pendingReveal?: string;
  createdAt: number;
  approvedAt?: number;
  lastUsedAt?: number;
  expiresAt?: number;
  allowedBundleIds?: string[];
  dailyLimit?: number;
  expiryNotifiedAt?: number;
  priority?: number;
}

export interface ApiKeyAuthResult {
  // undefined = unrestricted (root key, or a key created with no scope)
  allowedBundleIds?: string[];
  // undefined for the root API_KEY, which isn't owned by any dashboard account.
  ownerId?: string;
  priority?: number;
  // undefined for the root API_KEY, which has no stored record to attribute bundle usage to.
  keyId?: string;
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
  schedulerRetryCount: number;
  deviceOfflineAlertMinutes: number;
  batteryHotAlertC: number;
  batteryLowAlertPercent: number;
  diskFullAlertPercent: number;
  deviceStorageAlertPercent: number;
  testFlightBridgeAlertMinutes: number;
  jobWebhookUrl: string;
  jobWebhookEnabled: boolean;
  jobHistoryRetentionDays: number;
}

export interface AppWatch {
  id: string;
  name?: string;
  bundleId: string;
  appRepo: string;
  ghDispatchRepo: string;
  ghWorkflowFile: string;
  pollCron: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
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

export type WebhookDeliveryKind = 'scheduler' | 'job';

export interface WebhookDeliveryEntry {
  id: string;
  ts: number;
  kind: WebhookDeliveryKind;
  event: string;
  targetHost: string;
  ok: boolean;
  status?: number;
  error?: string;
  durationMs: number;
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
  testflight?: TestFlightJobSource;
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

interface AppleAuthAlert {
  suspected: boolean;
  lastError?: string;
  lastErrorAt?: number;
}

export interface UserPrefs {
  theme?: 'dark' | 'light' | 'auto';
  density?: 'comfortable' | 'compact';
  accent?: string;
}

export type AuditAction =
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
  | 'device.remove';

export interface AuditLogEntry {
  id: string;
  ts: number;
  actor: string;
  action: AuditAction;
  target: string;
  detail?: string;
}

// runStatus is only meaningful once a dispatch actually went out (ok && triggered) - it starts at
// 'dispatched' the moment the repository_dispatch call succeeds and is patched in place once the
// GitHub Actions run it kicked off actually finishes, instead of the caller blocking on that wait.
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

export interface ApiKeyUsageBucket {
  date: string;
  count: number;
}

export interface DeviceHealthCheck {
  ts: number;
  reachable: boolean;
  batteryPercent?: number;
  batteryTemperatureC?: number;
  storageUsedPercent?: number;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface ShareLinkRecord {
  id: string;
  jobId: string;
  bundleId: string;
  token: string;
  issuedBy: string;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

interface PersistedState {
  version: 6;
  apiKeys: ApiKeyRecord[];
  allowedUsers: AllowedUser[];
  settings: Partial<SchedulerSettings>;
  watches: AppWatch[];
  devices: DeviceRecord[];
  jobHistory: JobHistoryEntry[];
  appleAuthAlert: AppleAuthAlert;
  lastSchedulerRunAt?: number;
  userPrefs: Record<string, UserPrefs>;
  auditLog: AuditLogEntry[];
  schedulerRunHistory: SchedulerRunEntry[];
  rootSessionVersion: number;
  apiKeyUsage: Record<string, ApiKeyUsageBucket[]>;
  deviceHealthHistory: Record<string, DeviceHealthCheck[]>;
  pushSubscriptions: Record<string, PushSubscriptionRecord[]>;
  vapidKeys?: VapidKeys;
  apiKeyBundleUsage: Record<string, Record<string, number>>;
  shareLinks: ShareLinkRecord[];
  webhookDeliveryLog: WebhookDeliveryEntry[];
}

const MAX_HISTORY = 100;
const MAX_AUDIT_LOG = 200;
const MAX_SCHEDULER_RUNS = 20;
const MAX_SHARE_LINKS = 200;
const MAX_USAGE_DAYS = 30;
const MAX_DEVICE_HEALTH_CHECKS = 288; // 24h at a 5-minute poll interval, per device
const MAX_WEBHOOK_LOG = 200;
const statePath = path.join(config.stateDir, 'state.json');

function defaultState(): PersistedState {
  return {
    version: 6,
    apiKeys: [],
    allowedUsers: [],
    settings: {},
    watches: [],
    devices: [],
    jobHistory: [],
    appleAuthAlert: { suspected: false },
    userPrefs: {},
    auditLog: [],
    schedulerRunHistory: [],
    rootSessionVersion: 0,
    apiKeyUsage: {},
    deviceHealthHistory: {},
    pushSubscriptions: {},
    apiKeyBundleUsage: {},
    shareLinks: [],
    webhookDeliveryLog: [],
  };
}

// Every legacy branch below produces a v5-shaped object (as it always has); this final hop
// carries any of them the rest of the way to v6 so the multi-watch/multi-device/webhook-log
// additions only need to be handled in one place.
function migrateV5ToV6(v5: Record<string, unknown>): PersistedState {
  const legacyHealthHistory = v5.deviceHealthHistory;
  return {
    ...defaultState(),
    ...v5,
    version: 6,
    watches: Array.isArray(v5.watches) ? (v5.watches as AppWatch[]) : [],
    devices: Array.isArray(v5.devices) ? (v5.devices as DeviceRecord[]) : [],
    webhookDeliveryLog: Array.isArray(v5.webhookDeliveryLog) ? (v5.webhookDeliveryLog as WebhookDeliveryEntry[]) : [],
    deviceHealthHistory: Array.isArray(legacyHealthHistory)
      ? { default: (legacyHealthHistory as DeviceHealthCheck[]).slice(-MAX_DEVICE_HEALTH_CHECKS) }
      : typeof legacyHealthHistory === 'object' && legacyHealthHistory !== null
        ? (legacyHealthHistory as Record<string, DeviceHealthCheck[]>)
        : {},
  } as PersistedState;
}

function migrate(raw: Record<string, unknown>): PersistedState {
  if (raw.version === 6) return { ...defaultState(), ...raw } as PersistedState;
  if (raw.version === 5) return migrateV5ToV6(raw);

  if (raw.version === 4) {
    const v4Users = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return migrateV5ToV6({
      ...raw,
      version: 5,
      allowedUsers: v4Users.map((u) => ({
        username: u.username as string,
        permissions: migratePermissionsV4(u.permissions as LegacyV4Permissions),
        addedAt: u.addedAt as number,
      })),
    });
  }

  if (raw.version === 3) {
    const v3Users = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return migrateV5ToV6({
      ...raw,
      version: 5,
      allowedUsers: v3Users.map((u) => ({
        username: u.username as string,
        permissions: migratePermissionsV3(u.permissions as LegacyV3Permissions),
        addedAt: u.addedAt as number,
      })),
    });
  }

  if (raw.version === 2) {
    const legacyUsers = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return migrateV5ToV6({
      ...raw,
      version: 5,
      allowedUsers: legacyUsers.map((u) => ({
        username: u.username as string,
        permissions: legacyRoleToPermissions(String(u.role ?? '')),
        addedAt: u.addedAt as number,
      })),
    });
  }

  const legacyKeys = Array.isArray(raw.apiKeys) ? (raw.apiKeys as Record<string, unknown>[]) : [];
  return migrateV5ToV6({
    apiKeys: legacyKeys.map((k) => ({
      id: k.id as string,
      name: k.name as string,
      ownerId: 'root',
      status: 'approved',
      hash: k.hash as string,
      createdAt: k.createdAt as number,
      approvedAt: k.createdAt as number,
      lastUsedAt: k.lastUsedAt as number | undefined,
    })),
    settings: (raw.settings as Partial<SchedulerSettings>) ?? {},
    jobHistory: (raw.jobHistory as JobHistoryEntry[]) ?? [],
    appleAuthAlert: (raw.appleAuthAlert as AppleAuthAlert) ?? { suspected: false },
  });
}

function normalizeLegacySchedulerRunOutcome(raw: unknown): SchedulerRunOutcome {
  const o = (raw ?? {}) as Partial<SchedulerRunOutcome>;
  return {
    ok: typeof o.ok === 'boolean' ? o.ok : true,
    triggered: Boolean(o.triggered),
    reason: o.reason ?? '',
    runUrl: o.runUrl,
    runStatus: o.runStatus,
  };
}

function normalizeLegacySchedulerRunHistory(entries: unknown): SchedulerRunEntry[] {
  if (!Array.isArray(entries)) return [];
  return (entries as Record<string, unknown>[]).map((e) => ({
    id: typeof e.id === 'string' ? e.id : randomUUID(),
    ts: e.ts as number,
    appStore: normalizeLegacySchedulerRunOutcome(e.appStore),
    testflight: normalizeLegacySchedulerRunOutcome(e.testflight),
  }));
}

function load(): PersistedState {
  mkdirSync(config.stateDir, { recursive: true });
  if (!existsSync(statePath)) return defaultState();
  try {
    const migrated = migrate(JSON.parse(readFileSync(statePath, 'utf8')));
    migrated.schedulerRunHistory = normalizeLegacySchedulerRunHistory(migrated.schedulerRunHistory);
    return migrated;
  } catch {
    return defaultState();
  }
}

const state: PersistedState = load();
let dirty = false;

function persistNow(): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  dirty = false;
}

export function startStateFlusher(): void {
  setInterval(() => {
    if (dirty) persistNow();
  }, 30_000).unref();
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function listAllowedUsers(): AllowedUser[] {
  return state.allowedUsers;
}

export function getUserPermissions(username: string): Permissions | undefined {
  return state.allowedUsers.find((u) => u.username === username.toLowerCase())?.permissions;
}

export function getSessionVersion(username: string): number {
  if (username === 'root') return state.rootSessionVersion;
  return state.allowedUsers.find((u) => u.username === username.toLowerCase())?.sessionVersion ?? 0;
}

// Bumping invalidates every cookie signed with the previous version, including the one making
// this request - the caller is expected to also clear its own cookie so it doesn't just 401 on refresh.
export function bumpSessionVersion(username: string): void {
  if (username === 'root') {
    state.rootSessionVersion += 1;
    persistNow();
    return;
  }
  const user = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!user) return;
  user.sessionVersion = (user.sessionVersion ?? 0) + 1;
  persistNow();
}

const ACTIVITY_THROTTLE_MS = 60_000;

// Lazily persisted (dirty flag, not persistNow) since this fires on nearly every dashboard
// request - an immediate disk write per request would be needless I/O for a homelab-scale app.
export function recordUserActivity(username: string): void {
  if (username === 'root') return;
  const user = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!user) return;
  const now = Date.now();
  if (user.lastActiveAt && now - user.lastActiveAt < ACTIVITY_THROTTLE_MS) return;
  user.lastActiveAt = now;
  dirty = true;
}

// True if applying this change would leave nobody on the allowlist able to grant access back
// (root's ADMIN_PASSWORD still works, but GitHub-OAuth-only teams would be locked out of self-service).
// Only blocks the change that actually removes the last holder - if this user never had
// manageUsers to begin with, deleting/editing them can't be what orphans it.
export function wouldOrphanManageUsers(username: string, newPermissions: Permissions | null): boolean {
  const lower = username.toLowerCase();
  const existing = state.allowedUsers.find((u) => u.username === lower);
  if (!existing?.permissions.manageUsers) return false;
  const othersHaveIt = state.allowedUsers.some((u) => u.username !== lower && u.permissions.manageUsers);
  if (othersHaveIt) return false;
  return !newPermissions?.manageUsers;
}

function permissionDiff(before: Permissions, after: Permissions): string {
  const changes = PERMISSION_KEYS.filter((k) => before[k] !== after[k]).map((k) => `${after[k] ? '+' : '-'}${k}`);
  return changes.length > 0 ? changes.join(', ') : '(no change)';
}

export function recordAudit(actor: string, action: AuditAction, target: string, detail?: string): void {
  state.auditLog.unshift({ id: randomUUID(), ts: Date.now(), actor, action, target, detail });
  if (state.auditLog.length > MAX_AUDIT_LOG) state.auditLog.length = MAX_AUDIT_LOG;
  persistNow();
}

export function getAuditLog(limit = 100): AuditLogEntry[] {
  return state.auditLog.slice(0, limit);
}

export function addAllowedUser(username: string, permissions: Permissions, actor: string): AllowedUser {
  const lower = username.toLowerCase();
  const normalized = normalizePermissions(permissions);
  const existing = state.allowedUsers.find((u) => u.username === lower);
  if (existing) {
    const detail = permissionDiff(existing.permissions, normalized);
    existing.permissions = normalized;
    persistNow();
    recordAudit(actor, 'user.update', lower, detail);
    return existing;
  }
  const record: AllowedUser = { username: lower, permissions: normalized, addedAt: Date.now() };
  state.allowedUsers.push(record);
  persistNow();
  recordAudit(actor, 'user.add', lower, permissionDiff(VIEWER_PERMISSIONS, normalized));
  return record;
}

export function updateAllowedUserPermissions(username: string, permissions: Permissions, actor: string): AllowedUser | undefined {
  const existing = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!existing) return undefined;
  const normalized = normalizePermissions(permissions);
  const detail = permissionDiff(existing.permissions, normalized);
  existing.permissions = normalized;
  persistNow();
  recordAudit(actor, 'user.update', existing.username, detail);
  return existing;
}

export function removeAllowedUser(username: string, actor: string): boolean {
  const before = state.allowedUsers.length;
  state.allowedUsers = state.allowedUsers.filter((u) => u.username !== username.toLowerCase());
  const changed = state.allowedUsers.length !== before;
  if (changed) {
    persistNow();
    recordAudit(actor, 'user.remove', username.toLowerCase());
  }
  return changed;
}

function redact(k: ApiKeyRecord) {
  return {
    id: k.id,
    name: k.name,
    ownerId: k.ownerId,
    status: k.status,
    createdAt: k.createdAt,
    approvedAt: k.approvedAt,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
    hasUnrevealedSecret: !!k.pendingReveal,
    allowedBundleIds: k.allowedBundleIds,
    dailyLimit: k.dailyLimit,
    priority: k.priority ?? 0,
  };
}

function expiresAtFromDays(expiresInDays?: number): number | undefined {
  return expiresInDays ? Date.now() + expiresInDays * 86_400_000 : undefined;
}

function sanitizeBundleIds(allowedBundleIds?: string[]): string[] | undefined {
  return allowedBundleIds && allowedBundleIds.length > 0 ? allowedBundleIds : undefined;
}

export function createApiKey(
  name: string,
  ownerId: string,
  expiresInDays?: number,
  allowedBundleIds?: string[],
  dailyLimit?: number,
): { id: string; name: string; key: string; createdAt: number; expiresAt?: number } {
  const key = randomBytes(32).toString('hex');
  const record: ApiKeyRecord = {
    id: randomUUID(),
    name,
    ownerId,
    status: 'approved',
    hash: hashKey(key),
    pendingReveal: key,
    createdAt: Date.now(),
    approvedAt: Date.now(),
    expiresAt: expiresAtFromDays(expiresInDays),
    allowedBundleIds: sanitizeBundleIds(allowedBundleIds),
    dailyLimit,
  };
  state.apiKeys.push(record);
  persistNow();
  return { id: record.id, name: record.name, key, createdAt: record.createdAt, expiresAt: record.expiresAt };
}

export function requestApiKey(name: string, ownerId: string, expiresInDays?: number, allowedBundleIds?: string[], dailyLimit?: number) {
  const record: ApiKeyRecord = {
    id: randomUUID(),
    name,
    ownerId,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: expiresAtFromDays(expiresInDays),
    allowedBundleIds: sanitizeBundleIds(allowedBundleIds),
    dailyLimit,
  };
  state.apiKeys.push(record);
  persistNow();
  return redact(record);
}

export function approveApiKey(id: string): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.status !== 'pending') return false;
  const key = randomBytes(32).toString('hex');
  record.status = 'approved';
  record.hash = hashKey(key);
  record.pendingReveal = key;
  record.approvedAt = Date.now();
  persistNow();
  return true;
}

export function bulkApproveApiKeys(ids: string[]): string[] {
  return ids.filter((id) => approveApiKey(id));
}

export function denyApiKey(id: string): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.status !== 'pending') return false;
  record.status = 'denied';
  persistNow();
  return true;
}

export function regenerateApiKey(id: string, requesterId: string): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.status !== 'approved' || record.ownerId !== requesterId) return false;
  const key = randomBytes(32).toString('hex');
  record.hash = hashKey(key);
  record.pendingReveal = key;
  persistNow();
  return true;
}

export function revealApiKeySecret(id: string, requesterId: string): string | undefined {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.ownerId !== requesterId || !record.pendingReveal) return undefined;
  const secret = record.pendingReveal;
  record.pendingReveal = undefined;
  persistNow();
  return secret;
}

export function getApiKeyById(id: string): ReturnType<typeof redact> | undefined {
  const record = state.apiKeys.find((k) => k.id === id);
  return record ? redact(record) : undefined;
}

export function listApiKeysForOwner(ownerId: string) {
  return state.apiKeys.filter((k) => k.ownerId === ownerId).map(redact);
}

export function listAllApiKeys() {
  return state.apiKeys.map(redact);
}

export function listAllApiKeysPage(offset: number, limit: number, search?: string): { keys: ReturnType<typeof redact>[]; total: number } {
  const needle = search?.trim().toLowerCase();
  const matching = needle ? state.apiKeys.filter((k) => k.name.toLowerCase().includes(needle) || k.ownerId.toLowerCase().includes(needle)) : state.apiKeys;
  const sorted = [...matching].sort((a, b) => b.createdAt - a.createdAt);
  return { keys: sorted.slice(offset, offset + limit).map(redact), total: sorted.length };
}

export function listPendingApiKeys() {
  return state.apiKeys.filter((k) => k.status === 'pending').map(redact);
}

export function revokeApiKey(id: string, requesterId: string, requesterIsAdmin: boolean): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record) return false;
  if (!requesterIsAdmin && record.ownerId !== requesterId) return false;

  state.apiKeys = state.apiKeys.filter((k) => k.id !== id);
  delete state.apiKeyUsage[id];
  delete state.apiKeyBundleUsage[id];
  persistNow();
  return true;
}

// Extends (or, for an already-expired/never-expiring key, sets) expiresAt by `days` from now -
// same semantics as creating a key with expiresInDays, just applied to existing keys in bulk.
export function bulkExtendApiKeyExpiry(ids: string[], days: number): string[] {
  const extended: string[] = [];
  const newExpiresAt = Date.now() + days * 86_400_000;
  for (const id of ids) {
    const record = state.apiKeys.find((k) => k.id === id);
    if (!record) continue;
    record.expiresAt = newExpiresAt;
    record.expiryNotifiedAt = undefined;
    extended.push(id);
  }
  if (extended.length > 0) persistNow();
  return extended;
}

export function bulkSetApiKeyDailyLimit(ids: string[], dailyLimit: number | undefined): string[] {
  const updated: string[] = [];
  for (const id of ids) {
    const record = state.apiKeys.find((k) => k.id === id);
    if (!record) continue;
    record.dailyLimit = dailyLimit;
    updated.push(id);
  }
  if (updated.length > 0) persistNow();
  return updated;
}

function todayUsageCount(id: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const buckets = state.apiKeyUsage[id] ?? [];
  return buckets[buckets.length - 1]?.date === today ? buckets[buckets.length - 1].count : 0;
}

function recordApiKeyUsage(id: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const buckets = state.apiKeyUsage[id] ?? [];
  const last = buckets[buckets.length - 1];
  if (last && last.date === today) {
    last.count += 1;
  } else {
    buckets.push({ date: today, count: 1 });
    if (buckets.length > MAX_USAGE_DAYS) buckets.shift();
  }
  state.apiKeyUsage[id] = buckets;
  dirty = true;
}

export function getApiKeyUsage(id: string, days: number): ApiKeyUsageBucket[] {
  const buckets = new Map((state.apiKeyUsage[id] ?? []).map((b) => [b.date, b.count]));
  const now = new Date();
  const out: ApiKeyUsageBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    out.push({ date, count: buckets.get(date) ?? 0 });
  }
  return out;
}

export function verifyApiKey(candidate: string): ApiKeyAuthResult | undefined | 'rate-limited' {
  if (safeEqualStr(candidate, config.apiKey)) return {};

  const hash = hashKey(candidate);
  const record = state.apiKeys.find((k) => k.status === 'approved' && k.hash === hash);
  if (!record) return undefined;
  if (record.expiresAt && Date.now() > record.expiresAt) return undefined;
  if (record.dailyLimit && todayUsageCount(record.id) >= record.dailyLimit) return 'rate-limited';

  record.lastUsedAt = Date.now();
  recordApiKeyUsage(record.id);
  dirty = true;
  return { allowedBundleIds: record.allowedBundleIds, ownerId: record.ownerId, priority: record.priority ?? 0, keyId: record.id };
}

const MAX_TRACKED_BUNDLES_PER_KEY = 100;

// Which bundle IDs a key was actually used to decrypt, not just a per-day request count - lets an
// admin see what a key is for at a glance instead of just how often it's called. Only called from
// the /v1/decrypt handler (the one endpoint where a bundleId is actually being requested), not
// from every status/file poll that also counts against the daily rate limit above.
export function recordApiKeyBundleUsage(id: string, bundleId: string): void {
  const perKey = state.apiKeyBundleUsage[id] ?? {};
  perKey[bundleId] = (perKey[bundleId] ?? 0) + 1;
  if (Object.keys(perKey).length > MAX_TRACKED_BUNDLES_PER_KEY) {
    const leastUsed = Object.entries(perKey).sort((a, b) => a[1] - b[1])[0]?.[0];
    if (leastUsed) delete perKey[leastUsed];
  }
  state.apiKeyBundleUsage[id] = perKey;
  dirty = true;
}

export function getApiKeyBundleUsage(id: string, limit = 10): { bundleId: string; count: number }[] {
  const perKey = state.apiKeyBundleUsage[id] ?? {};
  return Object.entries(perKey)
    .map(([bundleId, count]) => ({ bundleId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// Priority for jobs queued from the dashboard itself (session-authenticated, not via an API key) -
// root always sits at the neutral default since it isn't a row in allowedUsers.
export function getUserPriority(username: string): number {
  if (username === 'root') return 0;
  return state.allowedUsers.find((u) => u.username === username.toLowerCase())?.priority ?? 0;
}

const MIN_PRIORITY = -5;
const MAX_PRIORITY = 5;

export function clampPriority(value: number): number {
  return Math.min(Math.max(Math.round(value), MIN_PRIORITY), MAX_PRIORITY);
}

export function setUserPriority(username: string, priority: number, actor: string): AllowedUser | undefined {
  const user = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!user) return undefined;
  const clamped = clampPriority(priority);
  if (user.priority === clamped) return user;
  const before = user.priority ?? 0;
  user.priority = clamped;
  persistNow();
  recordAudit(actor, 'user.update', user.username, `priority: ${before} -> ${clamped}`);
  return user;
}

export function setApiKeyPriority(id: string, priority: number): ApiKeyRecord | undefined {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record) return undefined;
  record.priority = clampPriority(priority);
  persistNow();
  return record;
}

const KEY_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

export function claimExpiringApiKeysToNotify(): { id: string; name: string; ownerId: string; expiresAt: number }[] {
  const now = Date.now();
  const due = state.apiKeys.filter(
    (k) => k.status === 'approved' && k.expiresAt && k.expiresAt - now <= KEY_EXPIRY_WARNING_MS && k.expiresAt > now && !k.expiryNotifiedAt,
  );
  for (const k of due) k.expiryNotifiedAt = now;
  if (due.length > 0) persistNow();
  return due.map((k) => ({ id: k.id, name: k.name, ownerId: k.ownerId, expiresAt: k.expiresAt as number }));
}

export function startApiKeySweeper(): void {
  setInterval(() => {
    const now = Date.now();
    const before = state.apiKeys.length;
    state.apiKeys = state.apiKeys.filter((k) => !(k.expiresAt && now > k.expiresAt));
    if (state.apiKeys.length !== before) persistNow();
  }, 60_000).unref();
}

export function getEffectiveSettings(): SchedulerSettings {
  return {
    notifyWebhookUrl: state.settings.notifyWebhookUrl ?? config.notifyWebhookUrl,
    notifyFormat: state.settings.notifyFormat ?? 'embed',
    notifyOnKeyRequest: state.settings.notifyOnKeyRequest ?? true,
    notifyOnDispatchSuccess: state.settings.notifyOnDispatchSuccess ?? true,
    notifyOnDispatchFailure: state.settings.notifyOnDispatchFailure ?? true,
    notifyOnAppleAuthAlert: state.settings.notifyOnAppleAuthAlert ?? true,
    notifyOnKeyExpiringSoon: state.settings.notifyOnKeyExpiringSoon ?? true,
    notifyOnDeviceOffline: state.settings.notifyOnDeviceOffline ?? true,
    notifyOnDeviceBatteryHot: state.settings.notifyOnDeviceBatteryHot ?? true,
    notifyOnDeviceBatteryLow: state.settings.notifyOnDeviceBatteryLow ?? true,
    notifyOnDiskFull: state.settings.notifyOnDiskFull ?? true,
    notifyOnDeviceStorageLow: state.settings.notifyOnDeviceStorageLow ?? true,
    notifyOnTestFlightBridgeDown: state.settings.notifyOnTestFlightBridgeDown ?? true,
    schedulerRetryCount: state.settings.schedulerRetryCount ?? 0,
    deviceOfflineAlertMinutes: state.settings.deviceOfflineAlertMinutes ?? 15,
    batteryHotAlertC: state.settings.batteryHotAlertC ?? 45,
    batteryLowAlertPercent: state.settings.batteryLowAlertPercent ?? 10,
    diskFullAlertPercent: state.settings.diskFullAlertPercent ?? 90,
    deviceStorageAlertPercent: state.settings.deviceStorageAlertPercent ?? 90,
    testFlightBridgeAlertMinutes: state.settings.testFlightBridgeAlertMinutes ?? 15,
    jobWebhookUrl: state.settings.jobWebhookUrl ?? '',
    jobWebhookEnabled: state.settings.jobWebhookEnabled ?? false,
    jobHistoryRetentionDays: state.settings.jobHistoryRetentionDays ?? 0,
  };
}

function diffSettings(before: SchedulerSettings, after: SchedulerSettings): string {
  const changed = (Object.keys(after) as (keyof SchedulerSettings)[]).filter((k) => before[k] !== after[k]);
  return changed.map((k) => `${k}: ${String(before[k])} -> ${String(after[k])}`).join(', ');
}

export function updateSettings(patch: Partial<SchedulerSettings>, actor?: string): SchedulerSettings {
  const before = getEffectiveSettings();
  state.settings = { ...state.settings, ...patch };
  persistNow();
  const after = getEffectiveSettings();
  if (actor) {
    const detail = diffSettings(before, after);
    if (detail) recordAudit(actor, 'settings.update', 'scheduler', detail);
  }
  return after;
}

// --- App watches (multi-app scheduler) ---------------------------------------------------

// Legacy single-watch env vars / pre-multi-watch settings fields, kept only as the fallback
// source for the synthetic 'default' watch below - never written to directly anymore.
interface LegacySingleWatchSettings {
  watchBundleId?: string;
  watchAppRepo?: string;
  ghDispatchRepo?: string;
  ghWorkflowFile?: string;
  pollCron?: string;
}

function getLegacySingleWatchFields(): Omit<AppWatch, 'id' | 'name' | 'enabled' | 'createdAt' | 'updatedAt'> | undefined {
  const legacy = state.settings as LegacySingleWatchSettings;
  const bundleId = legacy.watchBundleId || config.watchBundleId;
  if (!bundleId) return undefined;
  return {
    bundleId,
    appRepo: legacy.watchAppRepo || config.watchAppRepo,
    ghDispatchRepo: legacy.ghDispatchRepo || config.ghDispatchRepo,
    ghWorkflowFile: legacy.ghWorkflowFile || config.ghWorkflowFile,
    pollCron: legacy.pollCron || config.pollCron,
  };
}

// Recomputed live (not baked into state.json at migration time) so an existing single-watch
// install keeps tracking .env edits exactly like it does today via getEffectiveSettings().
export function getEffectiveWatches(): AppWatch[] {
  if (state.watches.length > 0) return state.watches;
  const legacy = getLegacySingleWatchFields();
  return legacy ? [{ id: 'default', enabled: true, createdAt: 0, updatedAt: 0, ...legacy }] : [];
}

export function listWatches(): AppWatch[] {
  return getEffectiveWatches();
}

export function getWatch(id: string): AppWatch | undefined {
  return getEffectiveWatches().find((w) => w.id === id);
}

function hasEnabledWatchWithBundleId(bundleId: string, excludeId?: string): boolean {
  return getEffectiveWatches().some((w) => w.enabled && w.bundleId === bundleId && w.id !== excludeId);
}

// Turns the synthetic 'default' watch (env-var-backed, never actually stored) into a real
// array entry on first edit, so "edit the existing single watch" transparently upgrades a
// fresh install to explicit multi-watch state without the caller needing to know the difference.
function materializeWatches(): void {
  if (state.watches.length > 0) return;
  const legacy = getLegacySingleWatchFields();
  if (legacy) state.watches = [{ id: 'default', enabled: true, createdAt: 0, updatedAt: 0, ...legacy }];
}

export interface CreateWatchInput {
  name?: string;
  bundleId: string;
  appRepo: string;
  ghDispatchRepo: string;
  ghWorkflowFile: string;
  pollCron: string;
  enabled?: boolean;
}

export function createWatch(input: CreateWatchInput, actor: string): { ok: boolean; watch?: AppWatch; error?: string } {
  materializeWatches();
  if (input.enabled !== false && hasEnabledWatchWithBundleId(input.bundleId)) {
    return { ok: false, error: `another enabled watch already targets ${input.bundleId}` };
  }
  const now = Date.now();
  const watch: AppWatch = {
    id: randomUUID(),
    name: input.name,
    bundleId: input.bundleId,
    appRepo: input.appRepo,
    ghDispatchRepo: input.ghDispatchRepo,
    ghWorkflowFile: input.ghWorkflowFile,
    pollCron: input.pollCron,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  state.watches.push(watch);
  persistNow();
  recordAudit(actor, 'watch.add', watch.id, watch.bundleId);
  return { ok: true, watch };
}

export function updateWatch(id: string, patch: Partial<CreateWatchInput>, actor: string): { ok: boolean; watch?: AppWatch; error?: string } {
  materializeWatches();
  const watch = state.watches.find((w) => w.id === id);
  if (!watch) return { ok: false, error: 'watch not found' };
  const nextBundleId = patch.bundleId ?? watch.bundleId;
  const nextEnabled = patch.enabled ?? watch.enabled;
  if (nextEnabled && hasEnabledWatchWithBundleId(nextBundleId, id)) {
    return { ok: false, error: `another enabled watch already targets ${nextBundleId}` };
  }
  Object.assign(watch, patch, { updatedAt: Date.now() });
  persistNow();
  recordAudit(actor, 'watch.update', watch.id, watch.bundleId);
  return { ok: true, watch };
}

export function deleteWatch(id: string, actor: string): boolean {
  materializeWatches();
  const before = state.watches.length;
  state.watches = state.watches.filter((w) => w.id !== id);
  const changed = state.watches.length !== before;
  if (changed) {
    persistNow();
    recordAudit(actor, 'watch.remove', id);
  }
  return changed;
}

export function isWatchSchedulable(watch: AppWatch): boolean {
  return watch.enabled && watch.bundleId !== '' && watch.appRepo !== '' && watch.ghDispatchRepo !== '' && config.ghToken !== '';
}

// Distinguishes "intentionally left blank" from a likely mistake: some but not all required
// fields set, or all set but the env-only GH_TOKEN missing so the watch silently never runs.
export function getWatchConfigIssues(watch: AppWatch): string[] {
  const fieldsSet = [watch.bundleId, watch.appRepo, watch.ghDispatchRepo].filter(Boolean).length;
  const issues: string[] = [];

  if (fieldsSet > 0 && fieldsSet < 3) {
    const missing = [
      !watch.bundleId && 'watch bundle ID',
      !watch.appRepo && 'watch app repo',
      !watch.ghDispatchRepo && 'GitHub dispatch repo',
    ].filter((v): v is string => typeof v === 'string');
    issues.push(`Watch is partially configured - still missing ${missing.join(', ')}.`);
  }

  if (fieldsSet === 3 && config.ghToken === '') {
    issues.push('Watch/dispatch repos are configured but GH_TOKEN is not set - this watch will never actually run.');
  }

  return issues;
}

// --- Device pool ---------------------------------------------------------------------------

export function getEffectiveDevices(): DeviceRecord[] {
  if (state.devices.length > 0) return state.devices;
  return [{ id: 'default', name: 'default', rootDir: config.ipadecryptRootDir, enabled: true, isPrimary: true, createdAt: 0, updatedAt: 0 }];
}

export function listDevices(): DeviceRecord[] {
  return getEffectiveDevices();
}

export function getDevice(id: string): DeviceRecord | undefined {
  return getEffectiveDevices().find((d) => d.id === id);
}

// Falls back to the first enabled device if none is explicitly flagged primary (shouldn't
// normally happen given updateDevice's invariant below, but keeps this total rather than
// possibly-undefined for every single-device call site).
export function getPrimaryDevice(): DeviceRecord {
  const devices = getEffectiveDevices().filter((d) => d.enabled);
  return devices.find((d) => d.isPrimary) ?? devices[0] ?? getEffectiveDevices()[0];
}

function materializeDevices(): void {
  if (state.devices.length > 0) return;
  state.devices = [
    { id: 'default', name: 'default', rootDir: config.ipadecryptRootDir, enabled: true, isPrimary: true, createdAt: 0, updatedAt: 0 },
  ];
}

export interface CreateDeviceInput {
  name: string;
  rootDir: string;
  enabled?: boolean;
  isPrimary?: boolean;
}

function clearOtherPrimaries(exceptId?: string): void {
  for (const d of state.devices) if (d.id !== exceptId) d.isPrimary = false;
}

export function createDevice(input: CreateDeviceInput, actor: string): DeviceRecord {
  materializeDevices();
  const now = Date.now();
  const makePrimary = input.isPrimary || !state.devices.some((d) => d.isPrimary);
  const device: DeviceRecord = {
    id: randomUUID(),
    name: input.name,
    rootDir: input.rootDir,
    enabled: input.enabled ?? true,
    isPrimary: makePrimary,
    createdAt: now,
    updatedAt: now,
  };
  if (makePrimary) clearOtherPrimaries();
  state.devices.push(device);
  persistNow();
  recordAudit(actor, 'device.add', device.id, device.name);
  return device;
}

export function updateDevice(id: string, patch: Partial<CreateDeviceInput>, actor: string): { ok: boolean; device?: DeviceRecord; error?: string } {
  materializeDevices();
  const device = state.devices.find((d) => d.id === id);
  if (!device) return { ok: false, error: 'device not found' };
  Object.assign(device, patch, { updatedAt: Date.now() });
  if (patch.isPrimary) clearOtherPrimaries(device.id);
  // Never leave zero primaries among enabled devices - promote the first remaining one.
  if (!state.devices.some((d) => d.enabled && d.isPrimary)) {
    const fallback = state.devices.find((d) => d.enabled);
    if (fallback) fallback.isPrimary = true;
  }
  persistNow();
  recordAudit(actor, 'device.update', device.id, device.name);
  return { ok: true, device };
}

export function deleteDevice(id: string, actor: string): boolean {
  materializeDevices();
  const before = state.devices.length;
  state.devices = state.devices.filter((d) => d.id !== id);
  const changed = state.devices.length !== before;
  if (changed) {
    if (!state.devices.some((d) => d.enabled && d.isPrimary)) {
      const fallback = state.devices.find((d) => d.enabled);
      if (fallback) fallback.isPrimary = true;
    }
    persistNow();
    recordAudit(actor, 'device.remove', id);
  }
  return changed;
}

// --- Webhook delivery log -------------------------------------------------------------------

export function recordWebhookDelivery(entry: Omit<WebhookDeliveryEntry, 'id' | 'ts'>): void {
  state.webhookDeliveryLog.unshift({ id: randomUUID(), ts: Date.now(), ...entry });
  if (state.webhookDeliveryLog.length > MAX_WEBHOOK_LOG) state.webhookDeliveryLog.length = MAX_WEBHOOK_LOG;
  persistNow();
}

export function getWebhookDeliveryLog(limit = 100): WebhookDeliveryEntry[] {
  return state.webhookDeliveryLog.slice(0, limit);
}

export function recordJobHistory(entry: JobHistoryEntry): void {
  state.jobHistory.unshift(entry);
  if (state.jobHistory.length > MAX_HISTORY) state.jobHistory.length = MAX_HISTORY;
  const retentionDays = getEffectiveSettings().jobHistoryRetentionDays;
  if (retentionDays > 0) {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    state.jobHistory = state.jobHistory.filter((e) => e.finishedAt >= cutoff);
  }
  persistNow();
  emitHistoryAdded(entry);
}

export function getJobHistoryPage(
  offset: number,
  limit: number,
  bundleIdSearch?: string,
  source?: 'manual' | 'scheduler',
  status?: 'done' | 'failed',
): { entries: JobHistoryEntry[]; total: number } {
  const filtered = state.jobHistory.filter(
    (e) =>
      (!bundleIdSearch || e.bundleId.toLowerCase().includes(bundleIdSearch.toLowerCase())) &&
      (!source || e.source === source) &&
      (!status || e.status === status),
  );
  return { entries: filtered.slice(offset, offset + limit), total: filtered.length };
}

export function getAllJobHistory(): JobHistoryEntry[] {
  return state.jobHistory;
}

export function getJobHistoryEntryById(id: string): JobHistoryEntry | undefined {
  return state.jobHistory.find((e) => e.id === id);
}

export function getAverageJobDurationMs(bundleId: string): number | undefined {
  const durations = state.jobHistory
    .filter((j) => j.bundleId === bundleId && j.status === 'done' && j.startedAt)
    .map((j) => j.finishedAt - (j.startedAt as number));
  if (durations.length === 0) return undefined;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
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

export function getBundleStats(bundleId: string): BundleStats {
  const runs = state.jobHistory.filter((j) => j.bundleId === bundleId);
  const doneCount = runs.filter((j) => j.status === 'done').length;
  const failedCount = runs.filter((j) => j.status === 'failed').length;
  return {
    bundleId,
    totalRuns: runs.length,
    doneCount,
    failedCount,
    successRate: runs.length > 0 ? doneCount / runs.length : 0,
    avgDurationMs: getAverageJobDurationMs(bundleId),
    lastRunAt: runs.length > 0 ? Math.max(...runs.map((j) => j.finishedAt)) : undefined,
    failureBreakdown: getFailureBreakdown(runs),
  };
}

export function getDailyVolume(days: number): { date: string; count: number }[] {
  const buckets = new Map<string, number>();
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const j of state.jobHistory) {
    if (j.status !== 'done') continue;
    const key = new Date(j.finishedAt).toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
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

function getFailureBreakdown(runs: JobHistoryEntry[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const j of runs) {
    if (j.status !== 'failed') continue;
    const category = categorizeFailure(j.error);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count);
}

export function getInsightsSummary(topAppsLimit = 5, trendDays = 14): InsightsSummary {
  const runs = state.jobHistory;
  const doneCount = runs.filter((j) => j.status === 'done').length;
  const failedCount = runs.filter((j) => j.status === 'failed').length;
  const totalSizeBytes = runs.reduce((sum, j) => sum + (j.sizeBytes ?? 0), 0);

  const byBundle = new Map<string, InsightsAppStats>();
  for (const j of runs) {
    const entry = byBundle.get(j.bundleId) ?? {
      bundleId: j.bundleId,
      totalRuns: 0,
      doneCount: 0,
      failedCount: 0,
      successRate: 0,
      totalSizeBytes: 0,
    };
    entry.totalRuns += 1;
    if (j.status === 'done') entry.doneCount += 1;
    else entry.failedCount += 1;
    entry.totalSizeBytes += j.sizeBytes ?? 0;
    byBundle.set(j.bundleId, entry);
  }
  const topApps = [...byBundle.values()]
    .map((a) => ({ ...a, successRate: a.totalRuns > 0 ? a.doneCount / a.totalRuns : 0 }))
    .sort((a, b) => b.totalRuns - a.totalRuns)
    .slice(0, topAppsLimit);

  return {
    totalRuns: runs.length,
    doneCount,
    failedCount,
    successRate: runs.length > 0 ? doneCount / runs.length : 0,
    totalSizeBytes,
    manualCount: runs.filter((j) => j.source === 'manual').length,
    schedulerCount: runs.filter((j) => j.source === 'scheduler').length,
    topApps,
    trend: getDailyVolume(trendDays),
    failureBreakdown: getFailureBreakdown(runs),
  };
}

export function recordSchedulerRun(): void {
  state.lastSchedulerRunAt = Date.now();
  persistNow();
}

export function getLastSchedulerRunAt(): number | undefined {
  return state.lastSchedulerRunAt;
}

export function recordSchedulerRunOutcome(outcome: Omit<SchedulerRunEntry, 'ts' | 'id'>): string {
  const id = randomUUID();
  state.schedulerRunHistory.unshift({ id, ts: Date.now(), ...outcome });
  if (state.schedulerRunHistory.length > MAX_SCHEDULER_RUNS) state.schedulerRunHistory.length = MAX_SCHEDULER_RUNS;
  persistNow();
  return id;
}

// Patches an already-recorded entry once its dispatched GitHub Actions run actually finishes -
// the entry is created (with runStatus 'dispatched') as soon as the dispatch call itself
// succeeds, so the caller isn't stuck waiting on a run that can take many minutes to complete.
export function updateSchedulerRunOutcome(entryId: string, source: 'appStore' | 'testflight', patch: Partial<SchedulerRunOutcome>): void {
  const entry = state.schedulerRunHistory.find((e) => e.id === entryId);
  if (!entry) return;
  entry[source] = { ...entry[source], ...patch };
  persistNow();
}

// Backfills watchId/bundleId on entries recorded before multi-watch existed - they were always
// about the single implicit watch, so this stays accurate as long as that watch still resolves.
export function getSchedulerRunHistory(limit = 10, watchId?: string): SchedulerRunEntry[] {
  const legacyWatch = getEffectiveWatches()[0];
  const filled = state.schedulerRunHistory.map((e) =>
    e.watchId ? e : { ...e, watchId: legacyWatch?.id, bundleId: legacyWatch?.bundleId },
  );
  const filtered = watchId ? filled.filter((e) => e.watchId === watchId) : filled;
  return filtered.slice(0, limit);
}

export function recordDeviceHealthCheck(
  deviceId: string,
  reachable: boolean,
  batteryPercent?: number,
  batteryTemperatureC?: number,
  storageUsedPercent?: number,
): void {
  const history = state.deviceHealthHistory[deviceId] ?? [];
  history.push({ ts: Date.now(), reachable, batteryPercent, batteryTemperatureC, storageUsedPercent });
  if (history.length > MAX_DEVICE_HEALTH_CHECKS) history.shift();
  state.deviceHealthHistory[deviceId] = history;
  persistNow();
}

function historyFor(deviceId: string): DeviceHealthCheck[] {
  return state.deviceHealthHistory[deviceId] ?? [];
}

export interface HourlyHealthBucket {
  hourStart: number;
  reachablePercent: number | null;
}

export function getDeviceHealthHourlyBuckets(deviceId: string, hours = 24): HourlyHealthBucket[] {
  const now = Date.now();
  const history = historyFor(deviceId);
  const buckets: HourlyHealthBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = now - i * 3_600_000;
    const hourEnd = hourStart + 3_600_000;
    const checks = history.filter((c) => c.ts >= hourStart && c.ts < hourEnd);
    buckets.push({ hourStart, reachablePercent: checks.length > 0 ? checks.filter((c) => c.reachable).length / checks.length : null });
  }
  return buckets;
}

export function getDeviceUptimePercent(deviceId: string, hours = 24): number | undefined {
  const cutoff = Date.now() - hours * 3_600_000;
  const recent = historyFor(deviceId).filter((c) => c.ts >= cutoff);
  if (recent.length === 0) return undefined;
  return recent.filter((c) => c.reachable).length / recent.length;
}

export interface HourlyBatteryBucket {
  hourStart: number;
  batteryPercent: number | null;
}

export function getDeviceBatteryHourlyBuckets(deviceId: string, hours = 24): HourlyBatteryBucket[] {
  const now = Date.now();
  const history = historyFor(deviceId);
  const buckets: HourlyBatteryBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = now - i * 3_600_000;
    const hourEnd = hourStart + 3_600_000;
    const readings = history
      .filter((c) => c.ts >= hourStart && c.ts < hourEnd && c.batteryPercent !== undefined)
      .map((c) => c.batteryPercent as number);
    buckets.push({ hourStart, batteryPercent: readings.length > 0 ? Math.round(readings.reduce((a, b) => a + b, 0) / readings.length) : null });
  }
  return buckets;
}

export interface HourlyTemperatureBucket {
  hourStart: number;
  batteryTemperatureC: number | null;
}

export function getDeviceTemperatureHourlyBuckets(deviceId: string, hours = 24): HourlyTemperatureBucket[] {
  const now = Date.now();
  const history = historyFor(deviceId);
  const buckets: HourlyTemperatureBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = now - i * 3_600_000;
    const hourEnd = hourStart + 3_600_000;
    const readings = history
      .filter((c) => c.ts >= hourStart && c.ts < hourEnd && c.batteryTemperatureC !== undefined)
      .map((c) => c.batteryTemperatureC as number);
    buckets.push({
      hourStart,
      batteryTemperatureC: readings.length > 0 ? Math.round((readings.reduce((a, b) => a + b, 0) / readings.length) * 10) / 10 : null,
    });
  }
  return buckets;
}

export interface HourlyStorageBucket {
  hourStart: number;
  storageUsedPercent: number | null;
}

export function getDeviceStorageHourlyBuckets(deviceId: string, hours = 24): HourlyStorageBucket[] {
  const now = Date.now();
  const history = historyFor(deviceId);
  const buckets: HourlyStorageBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = now - i * 3_600_000;
    const hourEnd = hourStart + 3_600_000;
    const readings = history
      .filter((c) => c.ts >= hourStart && c.ts < hourEnd && c.storageUsedPercent !== undefined)
      .map((c) => c.storageUsedPercent as number);
    buckets.push({ hourStart, storageUsedPercent: readings.length > 0 ? Math.round(readings.reduce((a, b) => a + b, 0) / readings.length) : null });
  }
  return buckets;
}

export function getAppleAuthAlert(): AppleAuthAlert {
  return state.appleAuthAlert;
}

export function setAppleAuthAlert(error: string): void {
  state.appleAuthAlert = { suspected: true, lastError: error, lastErrorAt: Date.now() };
  persistNow();
}

export function clearAppleAuthAlert(): void {
  if (!state.appleAuthAlert.suspected) return;
  state.appleAuthAlert = { suspected: false };
  persistNow();
}

// Generated once and persisted, same idea as the download signing secret - every subscribed
// browser is registered against this keypair, so rotating it would silently break them all.
export function getOrCreateVapidKeys(): VapidKeys {
  if (!state.vapidKeys) {
    state.vapidKeys = generateVAPIDKeys();
    persistNow();
  }
  return state.vapidKeys;
}

export function addPushSubscription(username: string, sub: PushSubscriptionRecord): void {
  const lower = username.toLowerCase();
  const existing = state.pushSubscriptions[lower] ?? [];
  if (existing.some((s) => s.endpoint === sub.endpoint)) return;
  state.pushSubscriptions[lower] = [...existing, sub];
  persistNow();
}

export function removePushSubscription(username: string, endpoint: string): void {
  const lower = username.toLowerCase();
  const existing = state.pushSubscriptions[lower];
  if (!existing) return;
  state.pushSubscriptions[lower] = existing.filter((s) => s.endpoint !== endpoint);
  persistNow();
}

export function getPushSubscriptions(username: string): PushSubscriptionRecord[] {
  return state.pushSubscriptions[username.toLowerCase()] ?? [];
}

// Tracks share links issued through the dashboard's own "Share" flow only - not the signed URLs
// the scheduler builds internally to hand a decrypted IPA to its own GitHub Actions workflow,
// which aren't user-facing and shouldn't show up as something to review/revoke here.
export function recordShareLink(jobId: string, bundleId: string, token: string, issuedBy: string, expiresAt: number): ShareLinkRecord {
  const record: ShareLinkRecord = { id: randomUUID(), jobId, bundleId, token, issuedBy, issuedAt: Date.now(), expiresAt, revoked: false };
  state.shareLinks.push(record);
  if (state.shareLinks.length > MAX_SHARE_LINKS) state.shareLinks.shift();
  persistNow();
  return record;
}

// Never includes the raw token - it's a live bearer credential for the file download, not
// something to hand back out over an endpoint that's just meant to list/audit issued links.
function redactShareLink(l: ShareLinkRecord) {
  return { id: l.id, jobId: l.jobId, bundleId: l.bundleId, issuedBy: l.issuedBy, issuedAt: l.issuedAt, expiresAt: l.expiresAt, revoked: l.revoked };
}

export function listShareLinksForJob(jobId: string): ReturnType<typeof redactShareLink>[] {
  return state.shareLinks
    .filter((l) => l.jobId === jobId)
    .sort((a, b) => b.issuedAt - a.issuedAt)
    .map(redactShareLink);
}

export function revokeShareLink(id: string): boolean {
  const record = state.shareLinks.find((l) => l.id === id);
  if (!record) return false;
  record.revoked = true;
  persistNow();
  return true;
}

export function isShareLinkRevoked(jobId: string, token: string): boolean {
  return state.shareLinks.some((l) => l.jobId === jobId && l.token === token && l.revoked);
}

export function getUserPrefs(username: string): UserPrefs {
  return state.userPrefs[username.toLowerCase()] ?? {};
}

export function updateUserPrefs(username: string, patch: Partial<UserPrefs>): UserPrefs {
  const lower = username.toLowerCase();
  const updated = { ...(state.userPrefs[lower] ?? {}), ...patch };
  state.userPrefs[lower] = updated;
  persistNow();
  return updated;
}

const BACKUP_VERSION = 2;

export interface BackupPayload {
  backupVersion: typeof BACKUP_VERSION;
  exportedAt: number;
  allowedUsers: AllowedUser[];
  apiKeys: ApiKeyRecord[];
  settings: Partial<SchedulerSettings>;
  watches: AppWatch[];
  devices: DeviceRecord[];
  jobHistory: JobHistoryEntry[];
  appleAuthAlert: AppleAuthAlert;
  lastSchedulerRunAt?: number;
  userPrefs: Record<string, UserPrefs>;
  auditLog: AuditLogEntry[];
  schedulerRunHistory: SchedulerRunEntry[];
  rootSessionVersion: number;
  apiKeyUsage: Record<string, ApiKeyUsageBucket[]>;
  apiKeyBundleUsage: Record<string, Record<string, number>>;
}

// The API key `hash` is a one-way SHA-256, safe to carry in a backup (restoring it is what keeps
// existing keys working) - only `pendingReveal`, an actual plaintext secret not yet shown to its
// owner, gets stripped.
export function exportBackup(): BackupPayload {
  return {
    backupVersion: BACKUP_VERSION,
    exportedAt: Date.now(),
    allowedUsers: state.allowedUsers,
    apiKeys: state.apiKeys.map((k) => ({ ...k, pendingReveal: undefined })),
    settings: state.settings,
    watches: getEffectiveWatches(),
    devices: getEffectiveDevices(),
    jobHistory: state.jobHistory,
    appleAuthAlert: state.appleAuthAlert,
    lastSchedulerRunAt: state.lastSchedulerRunAt,
    userPrefs: state.userPrefs,
    auditLog: state.auditLog,
    schedulerRunHistory: state.schedulerRunHistory,
    rootSessionVersion: state.rootSessionVersion,
    apiKeyUsage: state.apiKeyUsage,
    apiKeyBundleUsage: state.apiKeyBundleUsage,
  };
}

function isPermissionsShape(value: unknown): value is Permissions {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return PERMISSION_KEYS.every((k) => typeof p[k] === 'boolean');
}

function isAllowedUserShape(value: unknown): value is AllowedUser {
  if (typeof value !== 'object' || value === null) return false;
  const u = value as Record<string, unknown>;
  return typeof u.username === 'string' && typeof u.addedAt === 'number' && isPermissionsShape(u.permissions);
}

function isApiKeyRecordShape(value: unknown): value is ApiKeyRecord {
  if (typeof value !== 'object' || value === null) return false;
  const k = value as Record<string, unknown>;
  return (
    typeof k.id === 'string' &&
    typeof k.name === 'string' &&
    typeof k.ownerId === 'string' &&
    (k.status === 'pending' || k.status === 'approved' || k.status === 'denied') &&
    typeof k.createdAt === 'number'
  );
}

function isAppWatchShape(value: unknown): value is AppWatch {
  if (typeof value !== 'object' || value === null) return false;
  const w = value as Record<string, unknown>;
  return typeof w.id === 'string' && typeof w.bundleId === 'string' && typeof w.enabled === 'boolean';
}

function isDeviceRecordShape(value: unknown): value is DeviceRecord {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.id === 'string' && typeof d.name === 'string' && typeof d.rootDir === 'string' && typeof d.enabled === 'boolean';
}

function isJobHistoryEntryShape(value: unknown): value is JobHistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.bundleId === 'string' &&
    (e.status === 'done' || e.status === 'failed') &&
    typeof e.finishedAt === 'number'
  );
}

function isAuditLogEntryShape(value: unknown): value is AuditLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.ts === 'number' &&
    typeof e.actor === 'string' &&
    typeof e.action === 'string' &&
    typeof e.target === 'string'
  );
}

function isSchedulerRunEntryShape(value: unknown): value is SchedulerRunEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.ts === 'number' && typeof e.appStore === 'object' && typeof e.testflight === 'object';
}

export interface ImportBackupResult {
  ok: boolean;
  error?: string;
}

// All-or-nothing: a backup that's missing or has a malformed field is rejected outright rather
// than partially applied, so a bad file can't leave the server in a half-restored state.
export function importBackup(raw: unknown, actor: string): ImportBackupResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'not a valid backup file' };
  const b = raw as Record<string, unknown>;

  if (b.backupVersion !== BACKUP_VERSION) {
    return { ok: false, error: `unsupported backup version (expected ${BACKUP_VERSION})` };
  }
  if (!Array.isArray(b.allowedUsers) || !b.allowedUsers.every(isAllowedUserShape)) {
    return { ok: false, error: 'allowedUsers is missing or malformed' };
  }
  if (!Array.isArray(b.apiKeys) || !b.apiKeys.every(isApiKeyRecordShape)) {
    return { ok: false, error: 'apiKeys is missing or malformed' };
  }
  if (typeof b.settings !== 'object' || b.settings === null) {
    return { ok: false, error: 'settings is missing or malformed' };
  }
  if (!Array.isArray(b.watches) || !b.watches.every(isAppWatchShape)) {
    return { ok: false, error: 'watches is missing or malformed' };
  }
  if (!Array.isArray(b.devices) || !b.devices.every(isDeviceRecordShape)) {
    return { ok: false, error: 'devices is missing or malformed' };
  }
  if (!Array.isArray(b.jobHistory) || !b.jobHistory.every(isJobHistoryEntryShape)) {
    return { ok: false, error: 'jobHistory is missing or malformed' };
  }
  if (!Array.isArray(b.auditLog) || !b.auditLog.every(isAuditLogEntryShape)) {
    return { ok: false, error: 'auditLog is missing or malformed' };
  }
  if (!Array.isArray(b.schedulerRunHistory) || !b.schedulerRunHistory.every(isSchedulerRunEntryShape)) {
    return { ok: false, error: 'schedulerRunHistory is missing or malformed' };
  }
  if (typeof b.userPrefs !== 'object' || b.userPrefs === null) {
    return { ok: false, error: 'userPrefs is missing or malformed' };
  }
  if (typeof b.apiKeyUsage !== 'object' || b.apiKeyUsage === null) {
    return { ok: false, error: 'apiKeyUsage is missing or malformed' };
  }
  if (
    typeof b.appleAuthAlert !== 'object' ||
    b.appleAuthAlert === null ||
    typeof (b.appleAuthAlert as Record<string, unknown>).suspected !== 'boolean'
  ) {
    return { ok: false, error: 'appleAuthAlert is missing or malformed' };
  }
  if (typeof b.rootSessionVersion !== 'number') {
    return { ok: false, error: 'rootSessionVersion is missing or malformed' };
  }

  state.allowedUsers = b.allowedUsers as AllowedUser[];
  state.apiKeys = (b.apiKeys as ApiKeyRecord[]).map((k) => ({ ...k, pendingReveal: undefined }));
  state.settings = b.settings as Partial<SchedulerSettings>;
  state.watches = b.watches as AppWatch[];
  state.devices = b.devices as DeviceRecord[];
  state.jobHistory = (b.jobHistory as JobHistoryEntry[]).slice(0, MAX_HISTORY);
  state.auditLog = (b.auditLog as AuditLogEntry[]).slice(0, MAX_AUDIT_LOG);
  // Backfill ids for entries from a backup exported before SchedulerRunEntry had one.
  state.schedulerRunHistory = (b.schedulerRunHistory as SchedulerRunEntry[])
    .slice(0, MAX_SCHEDULER_RUNS)
    .map((e) => ({ ...e, id: e.id ?? randomUUID() }));
  state.userPrefs = b.userPrefs as Record<string, UserPrefs>;
  state.apiKeyUsage = b.apiKeyUsage as Record<string, ApiKeyUsageBucket[]>;
  state.appleAuthAlert = b.appleAuthAlert as AppleAuthAlert;
  state.rootSessionVersion = b.rootSessionVersion;
  if (typeof b.lastSchedulerRunAt === 'number') state.lastSchedulerRunAt = b.lastSchedulerRunAt;
  // Optional (not strictly validated) so a backup exported before this field existed still
  // imports cleanly instead of being rejected outright.
  state.apiKeyBundleUsage = typeof b.apiKeyBundleUsage === 'object' && b.apiKeyBundleUsage !== null
    ? (b.apiKeyBundleUsage as Record<string, Record<string, number>>)
    : {};

  persistNow();
  recordAudit(
    actor,
    'state.import',
    'server state',
    `restored from backup exported ${typeof b.exportedAt === 'number' ? new Date(b.exportedAt).toISOString() : 'unknown time'}`,
  );
  return { ok: true };
}
