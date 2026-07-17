import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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
}

export interface ApiKeyAuthResult {
  // undefined = unrestricted (root key, or a key created with no scope)
  allowedBundleIds?: string[];
  // undefined for the root API_KEY, which isn't owned by any dashboard account.
  ownerId?: string;
}

export interface SchedulerSettings {
  watchBundleId: string;
  watchAppRepo: string;
  ghDispatchRepo: string;
  ghWorkflowFile: string;
  pollCron: string;
  notifyWebhookUrl: string;
  notifyFormat: 'embed' | 'plain';
  notifyOnKeyRequest: boolean;
  notifyOnDispatchSuccess: boolean;
  notifyOnDispatchFailure: boolean;
  notifyOnAppleAuthAlert: boolean;
  notifyOnKeyExpiringSoon: boolean;
  notifyOnDeviceOffline: boolean;
  schedulerRetryCount: number;
  deviceOfflineAlertMinutes: number;
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
}

interface AppleAuthAlert {
  suspected: boolean;
  lastError?: string;
  lastErrorAt?: number;
}

export interface UserPrefs {
  theme?: 'dark' | 'light' | 'auto';
  density?: 'comfortable' | 'compact';
}

export type AuditAction = 'user.add' | 'user.update' | 'user.remove' | 'state.import' | 'settings.update';

export interface AuditLogEntry {
  id: string;
  ts: number;
  actor: string;
  action: AuditAction;
  target: string;
  detail?: string;
}

export interface SchedulerRunOutcome {
  ok: boolean;
  triggered: boolean;
  reason: string;
  runUrl?: string;
}

export interface SchedulerRunEntry {
  ts: number;
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
}

interface PersistedState {
  version: 5;
  apiKeys: ApiKeyRecord[];
  allowedUsers: AllowedUser[];
  settings: Partial<SchedulerSettings>;
  jobHistory: JobHistoryEntry[];
  appleAuthAlert: AppleAuthAlert;
  lastSchedulerRunAt?: number;
  userPrefs: Record<string, UserPrefs>;
  auditLog: AuditLogEntry[];
  schedulerRunHistory: SchedulerRunEntry[];
  rootSessionVersion: number;
  apiKeyUsage: Record<string, ApiKeyUsageBucket[]>;
  deviceHealthHistory: DeviceHealthCheck[];
}

const MAX_HISTORY = 100;
const MAX_AUDIT_LOG = 200;
const MAX_SCHEDULER_RUNS = 20;
const MAX_USAGE_DAYS = 30;
const MAX_DEVICE_HEALTH_CHECKS = 288; // 24h at a 5-minute poll interval
const statePath = path.join(config.stateDir, 'state.json');

function defaultState(): PersistedState {
  return {
    version: 5,
    apiKeys: [],
    allowedUsers: [],
    settings: {},
    jobHistory: [],
    appleAuthAlert: { suspected: false },
    userPrefs: {},
    auditLog: [],
    schedulerRunHistory: [],
    rootSessionVersion: 0,
    apiKeyUsage: {},
    deviceHealthHistory: [],
  };
}

function migrate(raw: Record<string, unknown>): PersistedState {
  if (raw.version === 5) return { ...defaultState(), ...raw } as PersistedState;

  if (raw.version === 4) {
    const v4Users = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return {
      ...defaultState(),
      ...raw,
      version: 5,
      allowedUsers: v4Users.map((u) => ({
        username: u.username as string,
        permissions: migratePermissionsV4(u.permissions as LegacyV4Permissions),
        addedAt: u.addedAt as number,
      })),
    } as PersistedState;
  }

  if (raw.version === 3) {
    const v3Users = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return {
      ...defaultState(),
      ...raw,
      version: 5,
      allowedUsers: v3Users.map((u) => ({
        username: u.username as string,
        permissions: migratePermissionsV3(u.permissions as LegacyV3Permissions),
        addedAt: u.addedAt as number,
      })),
    } as PersistedState;
  }

  if (raw.version === 2) {
    const legacyUsers = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return {
      ...defaultState(),
      ...raw,
      version: 5,
      allowedUsers: legacyUsers.map((u) => ({
        username: u.username as string,
        permissions: legacyRoleToPermissions(String(u.role ?? '')),
        addedAt: u.addedAt as number,
      })),
    } as PersistedState;
  }

  const legacyKeys = Array.isArray(raw.apiKeys) ? (raw.apiKeys as Record<string, unknown>[]) : [];
  return {
    ...defaultState(),
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
  };
}

function normalizeLegacySchedulerRunOutcome(raw: unknown): SchedulerRunOutcome {
  const o = (raw ?? {}) as Partial<SchedulerRunOutcome>;
  return {
    ok: typeof o.ok === 'boolean' ? o.ok : true,
    triggered: Boolean(o.triggered),
    reason: o.reason ?? '',
    runUrl: o.runUrl,
  };
}

function normalizeLegacySchedulerRunHistory(entries: unknown): SchedulerRunEntry[] {
  if (!Array.isArray(entries)) return [];
  return (entries as Record<string, unknown>[]).map((e) => ({
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

export function listAllApiKeysPage(offset: number, limit: number): { keys: ReturnType<typeof redact>[]; total: number } {
  const sorted = [...state.apiKeys].sort((a, b) => b.createdAt - a.createdAt);
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
  persistNow();
  return true;
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
  return { allowedBundleIds: record.allowedBundleIds, ownerId: record.ownerId };
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
    watchBundleId: state.settings.watchBundleId ?? config.watchBundleId,
    watchAppRepo: state.settings.watchAppRepo ?? config.watchAppRepo,
    ghDispatchRepo: state.settings.ghDispatchRepo ?? config.ghDispatchRepo,
    ghWorkflowFile: state.settings.ghWorkflowFile ?? config.ghWorkflowFile,
    pollCron: state.settings.pollCron ?? config.pollCron,
    notifyWebhookUrl: state.settings.notifyWebhookUrl ?? config.notifyWebhookUrl,
    notifyFormat: state.settings.notifyFormat ?? 'embed',
    notifyOnKeyRequest: state.settings.notifyOnKeyRequest ?? true,
    notifyOnDispatchSuccess: state.settings.notifyOnDispatchSuccess ?? true,
    notifyOnDispatchFailure: state.settings.notifyOnDispatchFailure ?? true,
    notifyOnAppleAuthAlert: state.settings.notifyOnAppleAuthAlert ?? true,
    notifyOnKeyExpiringSoon: state.settings.notifyOnKeyExpiringSoon ?? true,
    notifyOnDeviceOffline: state.settings.notifyOnDeviceOffline ?? true,
    schedulerRetryCount: state.settings.schedulerRetryCount ?? 0,
    deviceOfflineAlertMinutes: state.settings.deviceOfflineAlertMinutes ?? 15,
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

export function isSchedulerEnabled(): boolean {
  const s = getEffectiveSettings();
  return s.watchBundleId !== '' && s.watchAppRepo !== '' && s.ghDispatchRepo !== '' && config.ghToken !== '';
}

// Distinguishes "intentionally left blank" (nothing set at all - not worth nagging about) from a
// likely mistake: some but not all of the three required fields set, or all three set but the
// env-only GH_TOKEN missing so the scheduler silently never runs despite looking configured.
export function getSchedulerConfigIssues(): string[] {
  const s = getEffectiveSettings();
  const fieldsSet = [s.watchBundleId, s.watchAppRepo, s.ghDispatchRepo].filter(Boolean).length;
  const issues: string[] = [];

  if (fieldsSet > 0 && fieldsSet < 3) {
    const missing = [
      !s.watchBundleId && 'watch bundle ID',
      !s.watchAppRepo && 'watch app repo',
      !s.ghDispatchRepo && 'GitHub dispatch repo',
    ].filter((v): v is string => typeof v === 'string');
    issues.push(`Scheduler is partially configured - still missing ${missing.join(', ')}.`);
  }

  if (fieldsSet === 3 && config.ghToken === '') {
    issues.push('Watch/dispatch repos are configured but GH_TOKEN is not set - the scheduler will never actually run.');
  }

  return issues;
}

export function recordJobHistory(entry: JobHistoryEntry): void {
  state.jobHistory.unshift(entry);
  if (state.jobHistory.length > MAX_HISTORY) state.jobHistory.length = MAX_HISTORY;
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

export function recordSchedulerRunOutcome(outcome: Omit<SchedulerRunEntry, 'ts'>): void {
  state.schedulerRunHistory.unshift({ ts: Date.now(), ...outcome });
  if (state.schedulerRunHistory.length > MAX_SCHEDULER_RUNS) state.schedulerRunHistory.length = MAX_SCHEDULER_RUNS;
  persistNow();
}

export function getSchedulerRunHistory(limit = 10): SchedulerRunEntry[] {
  return state.schedulerRunHistory.slice(0, limit);
}

export function recordDeviceHealthCheck(reachable: boolean, batteryPercent?: number): void {
  state.deviceHealthHistory.push({ ts: Date.now(), reachable, batteryPercent });
  if (state.deviceHealthHistory.length > MAX_DEVICE_HEALTH_CHECKS) state.deviceHealthHistory.shift();
  persistNow();
}

export interface HourlyHealthBucket {
  hourStart: number;
  reachablePercent: number | null;
}

export function getDeviceHealthHourlyBuckets(hours = 24): HourlyHealthBucket[] {
  const now = Date.now();
  const buckets: HourlyHealthBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = now - i * 3_600_000;
    const hourEnd = hourStart + 3_600_000;
    const checks = state.deviceHealthHistory.filter((c) => c.ts >= hourStart && c.ts < hourEnd);
    buckets.push({ hourStart, reachablePercent: checks.length > 0 ? checks.filter((c) => c.reachable).length / checks.length : null });
  }
  return buckets;
}

export function getDeviceUptimePercent(hours = 24): number | undefined {
  const cutoff = Date.now() - hours * 3_600_000;
  const recent = state.deviceHealthHistory.filter((c) => c.ts >= cutoff);
  if (recent.length === 0) return undefined;
  return recent.filter((c) => c.reachable).length / recent.length;
}

export interface HourlyBatteryBucket {
  hourStart: number;
  batteryPercent: number | null;
}

export function getDeviceBatteryHourlyBuckets(hours = 24): HourlyBatteryBucket[] {
  const now = Date.now();
  const buckets: HourlyBatteryBucket[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const hourStart = now - i * 3_600_000;
    const hourEnd = hourStart + 3_600_000;
    const readings = state.deviceHealthHistory
      .filter((c) => c.ts >= hourStart && c.ts < hourEnd && c.batteryPercent !== undefined)
      .map((c) => c.batteryPercent as number);
    buckets.push({ hourStart, batteryPercent: readings.length > 0 ? Math.round(readings.reduce((a, b) => a + b, 0) / readings.length) : null });
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

const BACKUP_VERSION = 1;

export interface BackupPayload {
  backupVersion: typeof BACKUP_VERSION;
  exportedAt: number;
  allowedUsers: AllowedUser[];
  apiKeys: ApiKeyRecord[];
  settings: Partial<SchedulerSettings>;
  jobHistory: JobHistoryEntry[];
  appleAuthAlert: AppleAuthAlert;
  lastSchedulerRunAt?: number;
  userPrefs: Record<string, UserPrefs>;
  auditLog: AuditLogEntry[];
  schedulerRunHistory: SchedulerRunEntry[];
  rootSessionVersion: number;
  apiKeyUsage: Record<string, ApiKeyUsageBucket[]>;
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
    jobHistory: state.jobHistory,
    appleAuthAlert: state.appleAuthAlert,
    lastSchedulerRunAt: state.lastSchedulerRunAt,
    userPrefs: state.userPrefs,
    auditLog: state.auditLog,
    schedulerRunHistory: state.schedulerRunHistory,
    rootSessionVersion: state.rootSessionVersion,
    apiKeyUsage: state.apiKeyUsage,
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
  state.jobHistory = (b.jobHistory as JobHistoryEntry[]).slice(0, MAX_HISTORY);
  state.auditLog = (b.auditLog as AuditLogEntry[]).slice(0, MAX_AUDIT_LOG);
  state.schedulerRunHistory = (b.schedulerRunHistory as SchedulerRunEntry[]).slice(0, MAX_SCHEDULER_RUNS);
  state.userPrefs = b.userPrefs as Record<string, UserPrefs>;
  state.apiKeyUsage = b.apiKeyUsage as Record<string, ApiKeyUsageBucket[]>;
  state.appleAuthAlert = b.appleAuthAlert as AppleAuthAlert;
  state.rootSessionVersion = b.rootSessionVersion;
  if (typeof b.lastSchedulerRunAt === 'number') state.lastSchedulerRunAt = b.lastSchedulerRunAt;

  persistNow();
  recordAudit(
    actor,
    'state.import',
    'server state',
    `restored from backup exported ${typeof b.exportedAt === 'number' ? new Date(b.exportedAt).toISOString() : 'unknown time'}`,
  );
  return { ok: true };
}
