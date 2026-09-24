import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateVAPIDKeys, type VapidKeys } from 'web-push';
import { config } from '#config.js';
import {
  exportBillingSnapshot,
  getBillingEntitlements,
  isBillingSnapshot,
  replaceBillingSnapshot,
  type BillingSnapshot,
} from '#billing.js';
import { emitHistoryAdded } from '#events.js';
import {
  exportIdentitySnapshot,
  isIdentitySnapshot,
  replaceIdentitySnapshot,
  type IdentitySnapshot,
} from '#identity.js';
import type { JobTimelineEvent, TestFlightJobSource } from '#jobs/types.js';
import { categorizeFailure } from '#util/failureCategory.js';
import { combineBits, hasPermission, parseBits, PermissionFlag, serializeBits } from '#permissions.js';
import { openStateDatabase, verifyDatabaseBackup, type StateDatabase } from '#store/sqlite.js';

export type ApiKeyStatus = 'pending' | 'approved' | 'denied';

export interface ApiKeyOutcomeUsage {
  route: string;
  success: number;
  clientError: number;
  serverError: number;
  lastAt: number;
}

export interface GitHubBudgetTelemetryEntry {
  id: string;
  ts: number;
  watchId: string;
  bundleId: string;
  estimatedRequests: number;
  observedRequests?: number;
  limit: number;
  remainingBefore: number;
  remainingAfter?: number;
  resetAt: number;
}

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

export const DEFAULT_ROLE_ID = 'everyone';

const DEFAULT_ROLE_COLOR = '#99aab5';
export const ROLE_COLOR_PRESETS = ['#99aab5', '#1abc9c', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#5865f2', '#2ecc71'];

function seedDefaultRole(now: number): Role {

  return {
    id: DEFAULT_ROLE_ID,
    name: '@everyone',
    color: DEFAULT_ROLE_COLOR,
    permissions: serializeBits(PermissionFlag.viewLogs),
    position: 0,
    isDefault: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function effectiveBitsForRoleIds(roleIds: string[], roles: Role[]): bigint {
  const byId = new Map(roles.map((r) => [r.id, r]));
  const held = roleIds.map((id) => byId.get(id)).filter((r): r is Role => !!r);
  const defaultRole = roles.find((r) => r.isDefault);
  return combineBits([...(defaultRole ? [parseBits(defaultRole.permissions)] : []), ...held.map((r) => parseBits(r.permissions))]);
}

export interface AllowedUser {
  username: string;
  roleIds: string[];
  addedAt: number;
  sessionVersion?: number;
  lastActiveAt?: number;
  priority?: number;

  discordPerkRoleIds?: string[];
  mfa?: UserMfaRecord;
}

export interface UserMfaRecord {
  enabled: boolean;
  secretCiphertext?: string;
  pendingSecretCiphertext?: string;
  recoveryCodeHashes?: string[];
  updatedAt?: number;
}

export interface PasskeyCredential {
  id: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports?: string[];
  name?: string;
  createdAt: number;
  lastUsedAt?: number;
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

export interface DiscordGuildConfiguration {
  id: string;
  name: string;
  icon: string | null;
}

export interface DiscordGuildRoleConfiguration {
  id: string;
  name: string;
  color: number;
}

export interface DiscordGuildMembership {
  guildId: string;
  roleIds: string[] | undefined;
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
  databaseFilename?: string;
  manifestFilename?: string;
  schemaVersion?: number;
  integrity?: 'verified' | 'failed';
  encryptedManifest?: boolean;
}

export interface ActiveSessionRecord {
  id: string;
  sub: string;
  createdAt: number;
  lastSeenAt: number;
  userAgent?: string;
  ip?: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  ownerId: string;
  status: ApiKeyStatus;
  hash?: string;
  pendingReveal?: string;
  previousHash?: string;
  previousHashExpiresAt?: number;
  createdAt: number;
  approvedAt?: number;
  lastUsedAt?: number;
  lastUsedIp?: string;
  expiresAt?: number;
  allowedBundleIds?: string[];
  dailyLimit?: number;
  maxConcurrent?: number;
  allowTestFlight?: boolean;
  expiryNotifiedAt?: number;
  priority?: number;
}

export interface ApiKeyAuthResult {

  allowedBundleIds?: string[];

  ownerId?: string;
  priority?: number;

  keyId?: string;

  allowTestFlight?: boolean;
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
  notifyOnQueueSloBreach: boolean;
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
  transport?: 'wifi' | 'usb';
  host?: string;
  port?: number;
  user?: string;
  udid?: string;
  usbmuxNetwork?: boolean;
  productType?: string;
  keyPath?: string;
  iosVersion?: string;
  toolchain?: string;
  notes?: string;
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
  architectures?: string[];
  entitlementKeys?: string[];
  embeddedFrameworks?: string[];
  fileCount?: number;
  compressedSizeBytes?: number;
  uncompressedSizeBytes?: number;
  codeSignaturePresent?: boolean;
}

export interface JobHistoryEntry {
  id: string;
  correlationId?: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: TestFlightJobSource;
  versionLabel?: string;
  queuedBy?: string;
  status: 'done' | 'failed';
  warnings?: string[];
  error?: string;
  artifactId?: string;
  sizeBytes?: number;
  sha256?: string;
  source: 'manual' | 'scheduler';
  createdAt: number;
  startedAt?: number;
  finishedAt: number;
  deviceId?: string;
  ipaMetadata?: IpaMetadata;
  ipaInfoPlist?: Record<string, unknown>;
  timeline?: JobTimelineEvent[];
  attempt?: number;
  retryCount?: number;
  deadlineAt?: number;
  deadlineExceeded?: boolean;
  failureClass?: string;
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

export interface TestFlightCatalogCacheApp {
  appId: number;
  bundleId: string;
  displayName: string;
  iconUrl?: string;
  sellerName?: string;
  category?: string;
  devices: Array<{ id: string; name: string }>;
  lastVerifiedAt: number;
  deviceSource: true;
}

export interface TestFlightCatalogCache {
  fetchedAt: number;
  deviceIds: string[];
  apps: TestFlightCatalogCacheApp[];
  complete?: boolean;
}

export type TestFlightSubscriptionStatus = 'pending' | 'approved' | 'denied' | 'withdrawn';
export type TestFlightSubscriptionDeviceStatus = 'pending' | 'syncing' | 'active' | 'unavailable' | 'unsupported' | 'error' | 'unsubscribed';
export const IMMUTABLE_TESTFLIGHT_BUNDLE_ID = 'com.hammerandchisel.discord';

export interface TestFlightSubscriptionDevice {
  deviceId: string;
  status: TestFlightSubscriptionDeviceStatus;
  appleMembership?: 'accepted' | 'pending' | 'unknown';
  lastVerifiedAt?: number;
  lastSyncedAt?: number;
  lastError?: string;
}

export interface TestFlightSubscription {
  id: string;
  url: string;
  inviteCode: string;
  requestedBy: string;
  status: TestFlightSubscriptionStatus;
  appId?: number;
  bundleId?: string;
  displayName?: string;
  iconUrl?: string;
  sellerName?: string;
  category?: string;
  createdAt: number;
  updatedAt: number;
  approvedAt?: number;
  approvedBy?: string;
  deniedAt?: number;
  deniedBy?: string;
  withdrawnAt?: number;
  withdrawnBy?: string;
  devices: TestFlightSubscriptionDevice[];
  devicePolicy: 'all-enabled';
}

export interface UserPrefs {
  theme?: 'dark' | 'light' | 'auto';
  density?: 'comfortable' | 'compact';
  accent?: string;
  sound?: boolean;
  pushOnSuccess?: boolean;
  pushOnFailure?: boolean;
  pushOnAlerts?: boolean;
  pushOnKeyExpiry?: boolean;
  emailOnSuccess?: boolean;
  emailOnFailure?: boolean;
  emailOnAlerts?: boolean;
  emailOnKeyExpiry?: boolean;
  notifyEmail?: string;
  preferPrimaryDevice?: boolean;
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
  | 'watch.import'
  | 'device.add'
  | 'device.update'
  | 'device.remove'
  | 'role.add'
  | 'role.update'
  | 'role.remove'
  | 'backup.schedule-update'
  | 'backup.create'
  | 'backup.delete'
  | 'testflight-subscription.add'
  | 'testflight-subscription.approve'
  | 'testflight-subscription.deny'
  | 'testflight-subscription.sync'
  | 'testflight-subscription.remove'
  | 'billing.checkout'
  | 'billing.activated'
  | 'billing.charge'
  | 'billing.charge-failed'
  | 'billing.cancel'
  | 'billing.webhook'
  | 'billing.webhook.replay'
  | 'privacy.export'
  | 'privacy.delete'
  | 'auth.passkey.add'
  | 'auth.passkey.remove'
  | 'auth.passkey.login'
  | 'auth.passkey.reauthenticate';

export interface AuditLogEntry {
  id: string;
  ts: number;
  actor: string;
  action: AuditAction;
  target: string;
  detail?: string;
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
  versionLabel?: string;
  dispatchTargetKeys?: string[];
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

export interface DeviceActivityEntry {
  id: string;
  ts: number;
  deviceId: string;
  kind: 'health' | 'bridge' | 'job';
  message: string;
  bundleId?: string;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface NotificationRecord {
  id: string;
  userId: string;
  title: string;
  message: string;
  severity: NotificationSeverity;
  createdAt: number;
  readAt?: number;
  jobId?: string;
  href?: string;
}

interface PersistedState {
  version: 15;
  apiKeys: ApiKeyRecord[];
  allowedUsers: AllowedUser[];
  roles: Role[];
  settings: Partial<SchedulerSettings>;
  watches: AppWatch[];
  devices: DeviceRecord[];
  jobHistory: JobHistoryEntry[];
  lastSchedulerRunAt?: number;
  userPrefs: Record<string, UserPrefs>;
  auditLog: AuditLogEntry[];
  schedulerRunHistory: SchedulerRunEntry[];
  rootSessionVersion: number;
  apiKeyUsage: Record<string, ApiKeyUsageBucket[]>;
  deviceHealthHistory: Record<string, DeviceHealthCheck[]>;
  deviceActivity: DeviceActivityEntry[];
  pushSubscriptions: Record<string, PushSubscriptionRecord[]>;
  vapidKeys?: VapidKeys;
  apiKeyBundleUsage: Record<string, Record<string, number>>;
  apiKeyOutcomeUsage: Record<string, Record<string, ApiKeyOutcomeUsage>>;
  githubBudgetTelemetry: GitHubBudgetTelemetryEntry[];
  webhookDeliveryLog: WebhookDeliveryEntry[];
  discordRolePerks: DiscordRolePerk[];
  discordGuilds: DiscordGuildConfiguration[];
  backupSchedule: BackupScheduleSettings;
  backupHistory: BackupHistoryEntry[];
  activeSessions: ActiveSessionRecord[];
  appCatalog: Record<string, AppCatalogEntry>;
  testFlightCatalog?: TestFlightCatalogCache;
  notifications: NotificationRecord[];
  testFlightSubscriptions: TestFlightSubscription[];
  rootMfa?: UserMfaRecord;
  passkeys: PasskeyCredential[];
}

const MAX_HISTORY = 100;
const MAX_AUDIT_LOG = 200;
const MAX_SCHEDULER_RUNS = 20;
const MAX_USAGE_DAYS = 30;
const MAX_DEVICE_HEALTH_CHECKS = 288;
const MAX_DEVICE_ACTIVITY = 300;
const MAX_WEBHOOK_LOG = 200;
const MAX_NOTIFICATIONS = 500;
const statePath = path.join(config.stateDir, 'state.json');
const backupsDir = path.join(config.stateDir, 'backups');
const stateDatabase: StateDatabase = openStateDatabase({
  stateDir: config.stateDir,
  filename: config.stateDatabaseFile,
  busyTimeoutMs: config.stateDbBusyTimeoutMs,
  migrationDryRun: config.stateDbMigrationDryRun,
});

export function getStateDatabaseStatus(): { path: string; schemaVersion: number; integrity: 'ok' } {
  return { path: stateDatabase.path, schemaVersion: stateDatabase.schemaVersion, integrity: stateDatabase.integrityStatus() };
}

export function closeStateDatabase(): void {
  stateDatabase.close();
}

function defaultState(): PersistedState {
  return {
    version: 15,
    apiKeys: [],
    allowedUsers: [],
    roles: [seedDefaultRole(Date.now())],
    settings: {},
    watches: [],
    devices: [],
    jobHistory: [],
    userPrefs: {},
    auditLog: [],
    schedulerRunHistory: [],
    rootSessionVersion: 0,
    apiKeyUsage: {},
    deviceHealthHistory: {},
    deviceActivity: [],
    pushSubscriptions: {},
    apiKeyBundleUsage: {},
    apiKeyOutcomeUsage: {},
    githubBudgetTelemetry: [],
    webhookDeliveryLog: [],
    discordRolePerks: [],
    discordGuilds: [],
    backupSchedule: { enabled: false, cron: '0 3 * * *', retentionCount: 14 },
    backupHistory: [],
    activeSessions: [],
    appCatalog: {},
    notifications: [],
    testFlightSubscriptions: [],
    rootMfa: undefined,
    passkeys: [],
  };
}

interface LegacyPermissions {
  decrypt: boolean;
  viewApiKeys: boolean;
  approveApiKeys: boolean;
  revokeApiKeys: boolean;
  manageScheduler: boolean;
  triggerDispatch: boolean;
  viewLogs: boolean;
  viewUsers: boolean;
  manageUsers: boolean;
}

const LEGACY_VIEWER_PERMISSIONS: LegacyPermissions = {
  decrypt: false,
  viewApiKeys: false,
  approveApiKeys: false,
  revokeApiKeys: false,
  manageScheduler: false,
  triggerDispatch: false,
  viewLogs: false,
  viewUsers: false,
  manageUsers: false,
};

const LEGACY_ADMIN_PERMISSIONS: LegacyPermissions = {
  decrypt: true,
  viewApiKeys: true,
  approveApiKeys: true,
  revokeApiKeys: true,
  manageScheduler: true,
  triggerDispatch: true,
  viewLogs: true,
  viewUsers: true,
  manageUsers: true,
};

function legacyRoleToPermissions(role: string): LegacyPermissions {
  switch (role) {
    case 'admin':
      return { ...LEGACY_ADMIN_PERMISSIONS };
    case 'operator':
      return { ...LEGACY_VIEWER_PERMISSIONS, decrypt: true, viewApiKeys: true, approveApiKeys: true, revokeApiKeys: true, viewLogs: true };
    case 'member':
      return { ...LEGACY_VIEWER_PERMISSIONS, decrypt: true, viewLogs: true };
    default:
      return { ...LEGACY_VIEWER_PERMISSIONS, viewLogs: true };
  }
}

interface LegacyV3Permissions {
  decrypt: boolean;
  manageKeys: boolean;
  manageSettings: boolean;
  manageUsers: boolean;
}

function migratePermissionsV3(old: LegacyV3Permissions): LegacyPermissions {
  return {
    decrypt: old.decrypt,
    viewApiKeys: old.manageKeys,
    approveApiKeys: old.manageKeys,
    revokeApiKeys: old.manageKeys,
    manageScheduler: old.manageSettings,
    triggerDispatch: old.manageSettings,
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
  viewUsers: boolean;
  manageUsers: boolean;
}

function migratePermissionsV4(old: LegacyV4Permissions): LegacyPermissions {
  return {
    decrypt: old.decrypt,
    viewApiKeys: old.viewApiKeys,
    approveApiKeys: old.approveApiKeys,
    revokeApiKeys: old.revokeApiKeys,
    manageScheduler: old.manageScheduler,
    triggerDispatch: old.manageScheduler,
    viewLogs: true,
    viewUsers: old.viewUsers,
    manageUsers: old.manageUsers,
  };
}

function legacyBooleansToBits(p: LegacyPermissions): bigint {
  if (Object.values(p).every(Boolean)) return PermissionFlag.administrator;
  let bits = 0n;
  if (p.decrypt) bits |= PermissionFlag.requestDecrypt | PermissionFlag.accessApi;
  if (p.viewApiKeys) bits |= PermissionFlag.viewApiKeys;
  if (p.approveApiKeys) bits |= PermissionFlag.approveApiKeys | PermissionFlag.manageApiKeyLimits;
  if (p.revokeApiKeys) bits |= PermissionFlag.revokeApiKeys;
  if (p.manageScheduler) bits |= PermissionFlag.manageWatches | PermissionFlag.manageDevices | PermissionFlag.manageSchedulerSettings;
  if (p.triggerDispatch) bits |= PermissionFlag.triggerDispatch;
  if (p.viewLogs) bits |= PermissionFlag.viewLogs;
  if (p.viewUsers) bits |= PermissionFlag.viewUsers;
  if (p.manageUsers) bits |= PermissionFlag.manageUsers | PermissionFlag.manageRoles | PermissionFlag.manageBackup;
  return bits;
}

const PRESET_ROLE_BITS: Record<string, bigint> = {
  Member: PermissionFlag.requestDecrypt | PermissionFlag.accessApi,
  'Key Manager': combineBits([
    PermissionFlag.requestDecrypt,
    PermissionFlag.accessApi,
    PermissionFlag.viewApiKeys,
    PermissionFlag.approveApiKeys,
    PermissionFlag.manageApiKeyLimits,
    PermissionFlag.revokeApiKeys,
  ]),
  'Ops Admin': combineBits([
    PermissionFlag.requestDecrypt,
    PermissionFlag.accessApi,
    PermissionFlag.manageWatches,
    PermissionFlag.manageDevices,
    PermissionFlag.manageSchedulerSettings,
    PermissionFlag.triggerDispatch,
  ]),
};

function presetNameForBits(bits: bigint): string | undefined {
  if (bits === PermissionFlag.administrator) return 'Admin';
  return Object.entries(PRESET_ROLE_BITS).find(([, presetBits]) => presetBits === bits)?.[0];
}

function migrateV5ToV6(v5: Record<string, unknown>): Record<string, unknown> {
  const legacyHealthHistory = v5.deviceHealthHistory;
  return {
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
  };
}

function migrateV6ToV8(v6: Record<string, unknown>): Record<string, unknown> {
  const now = Date.now();
  const roles: Role[] = [seedDefaultRole(now)];
  const roleIdByBits = new Map<string, string>();
  let position = 1;

  function roleIdForBits(bits: bigint): string[] {
    if (bits === 0n) return [];
    const key = bits.toString();
    const existing = roleIdByBits.get(key);
    if (existing) return [existing];
    const role: Role = {
      id: randomUUID(),
      name: presetNameForBits(bits) ?? `Migrated role ${roleIdByBits.size + 1}`,
      color: ROLE_COLOR_PRESETS[position % ROLE_COLOR_PRESETS.length],
      permissions: key,
      position: position++,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    roles.push(role);
    roleIdByBits.set(key, role.id);
    return [role.id];
  }

  const legacyUsers = Array.isArray(v6.allowedUsers) ? (v6.allowedUsers as Record<string, unknown>[]) : [];
  const allowedUsers: AllowedUser[] = legacyUsers.map((u) => ({
    username: u.username as string,
    roleIds: roleIdForBits(legacyBooleansToBits((u.permissions ?? LEGACY_VIEWER_PERMISSIONS) as LegacyPermissions)),
    addedAt: u.addedAt as number,
    sessionVersion: u.sessionVersion as number | undefined,
    lastActiveAt: u.lastActiveAt as number | undefined,
    priority: u.priority as number | undefined,
  }));

  return { ...defaultState(), ...v6, version: 8, roles, allowedUsers };
}

function migrateV7ToV8(v7: Record<string, unknown>): Record<string, unknown> {
  const roles = Array.isArray(v7.roles)
    ? (v7.roles as Role[]).map((role) => {
        const permissions = parseBits(role.permissions);
        const migratedPermissions = hasPermission(permissions, PermissionFlag.requestDecrypt)
          ? permissions | PermissionFlag.accessApi
          : permissions;
        return { ...role, permissions: serializeBits(migratedPermissions) };
      })
    : [seedDefaultRole(Date.now())];
  return { ...defaultState(), ...v7, version: 8, roles };
}

function migrateV8ToV9(v8: Record<string, unknown>): Record<string, unknown> {
  const legacyGuildId = typeof v8.discordGuildId === 'string' ? v8.discordGuildId : undefined;
  const { discordGuildId: _legacyGuildId, ...rest } = v8;
  const discordGuilds = legacyGuildId ? [{ id: legacyGuildId, name: legacyGuildId, icon: null }] : [];
  const discordRolePerks = Array.isArray(v8.discordRolePerks) && legacyGuildId
    ? (v8.discordRolePerks as Omit<DiscordRolePerk, 'guildId' | 'guildName' | 'guildIcon' | 'discordRoleColor'>[]).map((perk) => ({
        ...perk,
        guildId: legacyGuildId,
        guildName: legacyGuildId,
        guildIcon: null,
        discordRoleColor: 0,
      }))
    : [];
  return { ...defaultState(), ...rest, version: 9, discordGuilds, discordRolePerks };
}

function upgradePermissionBits(bits: bigint): bigint {
  let migrated = bits;
  if ((bits & PermissionFlag.viewUsers) !== 0n) migrated |= PermissionFlag.viewRoles;
  if ((bits & PermissionFlag.manageUsers) !== 0n) migrated |= PermissionFlag.viewUsers;
  if ((bits & PermissionFlag.manageRoles) !== 0n) migrated |= PermissionFlag.viewRoles | PermissionFlag.viewDiscordPerks | PermissionFlag.manageDiscordPerks;
  if ((bits & PermissionFlag.manageWatches) !== 0n || (bits & PermissionFlag.manageSchedulerSettings) !== 0n || (bits & PermissionFlag.triggerDispatch) !== 0n) migrated |= PermissionFlag.viewScheduler;
  if ((bits & PermissionFlag.manageDevices) !== 0n) migrated |= PermissionFlag.viewDevices;
  if ((bits & PermissionFlag.manageBackup) !== 0n) migrated |= PermissionFlag.viewBackup;
  if ((bits & (PermissionFlag.viewApiKeys | PermissionFlag.accessApi)) !== 0n) migrated |= PermissionFlag.viewApiKeyUsage;
  if ((bits & PermissionFlag.manageApiKeyLimits) !== 0n) {
    migrated |= PermissionFlag.manageApiKeyExpiry | PermissionFlag.manageApiKeyDailyLimits | PermissionFlag.manageApiKeyConcurrency | PermissionFlag.manageApiKeyTestFlight | PermissionFlag.manageApiKeyPriority;
  }
  return migrated;
}

function consolidatePermissionBits(bits: bigint): bigint {
  let migrated = bits;
  if ((bits & PermissionFlag.accessApi) !== 0n) migrated |= PermissionFlag.requestApiKeys | PermissionFlag.createApiKeys;
  const legacyManagesAllApiKeys = (bits & (PermissionFlag.approveApiKeys | PermissionFlag.revokeApiKeys | PermissionFlag.manageApiKeyLimits)) === (PermissionFlag.approveApiKeys | PermissionFlag.revokeApiKeys | PermissionFlag.manageApiKeyLimits);
  if (legacyManagesAllApiKeys) migrated |= PermissionFlag.manageApiKeys;
  if ((bits & (PermissionFlag.viewScheduler | PermissionFlag.manageWatches | PermissionFlag.manageSchedulerSettings | PermissionFlag.triggerDispatch)) !== 0n) migrated |= PermissionFlag.viewAutomation;
  const legacyManagesAllAutomation = (bits & (PermissionFlag.manageWatches | PermissionFlag.manageSchedulerSettings | PermissionFlag.triggerDispatch)) === (PermissionFlag.manageWatches | PermissionFlag.manageSchedulerSettings | PermissionFlag.triggerDispatch);
  if (legacyManagesAllAutomation) migrated |= PermissionFlag.manageAutomation;
  return migrated;
}

function migrateV9ToV10(v9: Record<string, unknown> | PersistedState): Record<string, unknown> {
  const roles = Array.isArray(v9.roles)
    ? (v9.roles as Role[]).map((role) => ({ ...role, permissions: serializeBits(upgradePermissionBits(parseBits(role.permissions))) }))
    : [seedDefaultRole(Date.now())];
  return { ...defaultState(), ...v9, version: 10, roles };
}

function migrateV10ToV11(v10: Record<string, unknown>): Record<string, unknown> {
  const v10State = migrateV9ToV10(v10);
  return {
    ...v10State,
    version: 11,
    roles: (v10State.roles as Role[]).map((role) => ({ ...role, permissions: serializeBits(consolidatePermissionBits(parseBits(role.permissions))) })),
  };
}

function migrateV11ToV12(v11: Record<string, unknown>): Record<string, unknown> {
  return { ...defaultState(), ...v11, version: 12 };
}

function migrateV12ToV13(v12: Record<string, unknown>): Record<string, unknown> {
  return {
    ...defaultState(),
    ...v12,
    version: 13,
    notifications: Array.isArray(v12.notifications) ? (v12.notifications as NotificationRecord[]) : [],
  };
}

function migrateV13ToV14(v13: Record<string, unknown>): PersistedState {
  const migrated = {
    ...defaultState(),
    ...v13,
    version: 15,
  } as PersistedState & { shareLinks?: unknown };
  delete migrated.shareLinks;
  migrated.testFlightSubscriptions = Array.isArray(v13.testFlightSubscriptions)
    ? (v13.testFlightSubscriptions as TestFlightSubscription[])
    : [];
  migrated.roles = Array.isArray(v13.roles)
    ? (v13.roles as Role[]).map((role) => ({ ...role, permissions: serializeBits(parseBits(role.permissions)) }))
    : [seedDefaultRole(Date.now())];
  return migrated;
}

function migrate(raw: Record<string, unknown>): PersistedState {
  if (raw.version === 15) return migrateV13ToV14(raw);
  if (raw.version === 14) return migrateV13ToV14(raw);
  if (raw.version === 13) return migrateV13ToV14(raw);
  if (raw.version === 12) return migrateV13ToV14(migrateV12ToV13(raw));
  if (raw.version === 11) return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(raw)));
  if (raw.version === 10) return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(raw))));
  if (raw.version === 9) return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(raw))));
  if (raw.version === 8) return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(raw)))));
  if (raw.version === 7) return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV7ToV8(raw))))));
  if (raw.version === 6) return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(raw))))));
  if (raw.version === 5) return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(migrateV5ToV6(raw)))))));

  if (raw.version === 4) {
    const v4Users = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
      migrateV5ToV6({
        ...raw,
        version: 5,
        allowedUsers: v4Users.map((u) => ({
          username: u.username as string,
          permissions: migratePermissionsV4(u.permissions as LegacyV4Permissions),
          addedAt: u.addedAt as number,
        })),
      }),
    ))))));
  }

  if (raw.version === 3) {
    const v3Users = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
      migrateV5ToV6({
        ...raw,
        version: 5,
        allowedUsers: v3Users.map((u) => ({
          username: u.username as string,
          permissions: migratePermissionsV3(u.permissions as LegacyV3Permissions),
          addedAt: u.addedAt as number,
        })),
      }),
    ))))));
  }

  if (raw.version === 2) {
    const legacyUsers = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
      migrateV5ToV6({
        ...raw,
        version: 5,
        allowedUsers: legacyUsers.map((u) => ({
          username: u.username as string,
          permissions: legacyRoleToPermissions(String(u.role ?? '')),
          addedAt: u.addedAt as number,
        })),
      }),
    ))))));
  }

  const legacyKeys = Array.isArray(raw.apiKeys) ? (raw.apiKeys as Record<string, unknown>[]) : [];
  return migrateV13ToV14(migrateV12ToV13(migrateV11ToV12(migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
    migrateV5ToV6({
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
    }),
  ))))));
}

function normalizeLegacySchedulerRunOutcome(raw: unknown): SchedulerRunOutcome {
  const o = (raw ?? {}) as Partial<SchedulerRunOutcome>;
  return {
    ok: typeof o.ok === 'boolean' ? o.ok : true,
    triggered: Boolean(o.triggered),
    reason: o.reason ?? '',
    runUrl: o.runUrl,
    runStatus: o.runStatus,
    observedVersion: o.observedVersion,
    installMode: o.installMode,
    versionLabel: typeof o.versionLabel === 'string' ? o.versionLabel : undefined,
    dispatchTargetKeys: Array.isArray(o.dispatchTargetKeys) ? o.dispatchTargetKeys.filter((key): key is string => typeof key === 'string') : undefined,
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
  const stored = stateDatabase.readState();
  if (stored !== undefined) {
    const migrated = normalizeLoadedState(migrate(asStateRecord(stored)));
    if (JSON.stringify(stored) !== JSON.stringify(migrated)) stateDatabase.writeState(migrated, statePath);
    return migrated;
  }
  try {
    const migrated = normalizeLoadedState(existsSync(statePath) ? migrate(asStateRecord(JSON.parse(readFileSync(statePath, 'utf8')))) : defaultState());
    stateDatabase.writeState(migrated, statePath);
    return migrated;
  } catch (error) {
    throw new Error(`could not initialize persistent state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asStateRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('persistent state must be a JSON object');
  const record = value as Record<string, unknown>;
  if (record.version !== undefined && typeof record.version !== 'number') throw new Error('persistent state version must be a number');
  return record;
}

function normalizeLoadedState(migrated: PersistedState): PersistedState {
  migrated.devices = migrated.devices.map(normalizeLoadedDevice);
  migrated.schedulerRunHistory = normalizeLegacySchedulerRunHistory(migrated.schedulerRunHistory);
  migrated.appCatalog = migrated.appCatalog ?? {};
  migrated.testFlightCatalog = isTestFlightCatalogCacheShape(migrated.testFlightCatalog) ? migrated.testFlightCatalog : undefined;
  migrated.notifications = Array.isArray(migrated.notifications) ? migrated.notifications.slice(0, MAX_NOTIFICATIONS) : [];
  migrated.testFlightSubscriptions = Array.isArray(migrated.testFlightSubscriptions) ? migrated.testFlightSubscriptions : [];
  return migrated;
}

function normalizeLoadedDevice(device: DeviceRecord): DeviceRecord {
  const { rootDir: _rootDir, ...normalized } = device as DeviceRecord & { rootDir?: string };
  if (!normalized.host && !normalized.udid) throw new Error(`device ${normalized.id} requires direct USB or Wi-Fi setup`);
  return normalized;
}

export function getAppCatalogEntry(bundleId: string): AppCatalogEntry | undefined {
  return state.appCatalog[bundleId];
}

export function getAppCatalogEntries(bundleIds: string[]): AppCatalogEntry[] {
  const unique = new Set(bundleIds.filter((bundleId) => !!bundleId));
  const entries: AppCatalogEntry[] = [];
  for (const bundleId of unique) {
    const entry = state.appCatalog[bundleId];
    if (entry) entries.push(entry);
  }
  return entries;
}

export function getAppCatalogStats(): { entries: number; icons: number; oldestUpdatedAt?: number; newestUpdatedAt?: number } {
  const entries = Object.values(state.appCatalog);
  const updatedAt = entries.map((entry) => entry.updatedAt).filter(Number.isFinite);
  return {
    entries: entries.length,
    icons: entries.filter((entry) => Boolean(entry.iconUrl)).length,
    oldestUpdatedAt: updatedAt.length ? Math.min(...updatedAt) : undefined,
    newestUpdatedAt: updatedAt.length ? Math.max(...updatedAt) : undefined,
  };
}

export function getTestFlightCatalogCache(): TestFlightCatalogCache | undefined {
  const cache = state.testFlightCatalog;
  if (!cache) return undefined;
  return {
    fetchedAt: cache.fetchedAt,
    deviceIds: [...cache.deviceIds],
    apps: cache.apps.map((app) => ({ ...app, devices: app.devices.map((device) => ({ ...device })) })),
    complete: cache.complete,
  };
}

export function setTestFlightCatalogCache(cache: TestFlightCatalogCache): void {
  state.testFlightCatalog = {
    fetchedAt: cache.fetchedAt,
    deviceIds: [...new Set(cache.deviceIds)],
    apps: cache.apps.map((app) => ({ ...app, devices: app.devices.map((device) => ({ ...device })) })),
    complete: cache.complete,
  };
  persistNow();
}

export function upsertAppCatalogEntry(entry: Omit<AppCatalogEntry, 'updatedAt'>): AppCatalogEntry {
  const normalized: AppCatalogEntry = {
    ...entry,
    bundleId: entry.bundleId.trim(),
    displayName: entry.displayName.trim(),
    updatedAt: Date.now(),
  };
  if (!normalized.bundleId || !normalized.displayName) {
    throw new Error('bundleId and displayName are required');
  }
  state.appCatalog[normalized.bundleId] = normalized;
  dirty = true;
  return normalized;
}

export function upsertAppCatalogEntries(entries: Array<Omit<AppCatalogEntry, 'updatedAt'>>): AppCatalogEntry[] {
  const updated: AppCatalogEntry[] = [];
  for (const entry of entries) {
    if (!entry.bundleId?.trim() || !entry.displayName?.trim()) continue;
    updated.push(
      upsertAppCatalogEntry({
        bundleId: entry.bundleId,
        displayName: entry.displayName,
        iconUrl: entry.iconUrl,
        trackId: entry.trackId,
        sellerName: entry.sellerName,
        category: entry.category,
        description: entry.description,
        screenshots: entry.screenshots?.slice(0, 10),
        releaseNotes: entry.releaseNotes,
        price: entry.price,
      }),
    );
  }
  if (updated.length > 0) persistNow();
  return updated;
}

const state: PersistedState = load();
let dirty = false;

function persistNow(): void {
  stateDatabase.writeState(state, statePath);
  dirty = false;
}

function encryptedBackupManifest(value: Record<string, unknown>): string {
  const key = createHash('sha256').update(config.sessionSigningSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64url'), tag: tag.toString('base64url'), ciphertext: ciphertext.toString('base64url') });
}

function verifyEncryptedBackupManifest(manifestPath: string, jsonPath: string, databasePath: string): void {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: number; algorithm?: string; iv?: string; tag?: string; ciphertext?: string };
  if (manifest.version !== 1 || manifest.algorithm !== 'aes-256-gcm' || !manifest.iv || !manifest.tag || !manifest.ciphertext) throw new Error('backup manifest is malformed');
  let payload: { jsonSha256?: string; databaseSha256?: string } | undefined;
  for (const secret of [config.sessionSigningSecret, config.sessionSigningSecretPrevious].filter(Boolean)) {
    try {
      const key = createHash('sha256').update(secret).digest();
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(manifest.tag, 'base64url'));
      payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(manifest.ciphertext, 'base64url')), decipher.final()]).toString('utf8')) as { jsonSha256?: string; databaseSha256?: string };
      break;
    } catch {
      continue;
    }
  }
  if (!payload) throw new Error('backup manifest encryption key did not match the current or previous session secret');
  const jsonSha256 = createHash('sha256').update(readFileSync(jsonPath)).digest('hex');
  const databaseSha256 = createHash('sha256').update(readFileSync(databasePath)).digest('hex');
  if (payload.jsonSha256 !== jsonSha256 || payload.databaseSha256 !== databaseSha256) throw new Error('backup manifest checksum verification failed');
}

export function startStateFlusher(): void {
  stateFlushTimer ??= setInterval(() => {
    if (dirty) persistNow();
  }, 30_000).unref();
}

let stateFlushTimer: NodeJS.Timeout | undefined;
let sessionSweepTimer: NodeJS.Timeout | undefined;
let apiKeySweepTimer: NodeJS.Timeout | undefined;

export function stopStateBackgroundServices(): void {
  if (stateFlushTimer) clearInterval(stateFlushTimer);
  if (sessionSweepTimer) clearInterval(sessionSweepTimer);
  if (apiKeySweepTimer) clearInterval(apiKeySweepTimer);
  stateFlushTimer = undefined;
  sessionSweepTimer = undefined;
  apiKeySweepTimer = undefined;
  if (dirty) persistNow();
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

export function getUserMfa(username: string): UserMfaRecord | undefined {
  if (username === 'root') return state.rootMfa ? { ...state.rootMfa, recoveryCodeHashes: state.rootMfa.recoveryCodeHashes ? [...state.rootMfa.recoveryCodeHashes] : undefined } : undefined;
  const user = state.allowedUsers.find((entry) => entry.username === username.toLowerCase());
  return user?.mfa ? { ...user.mfa, recoveryCodeHashes: user.mfa.recoveryCodeHashes ? [...user.mfa.recoveryCodeHashes] : undefined } : undefined;
}

export function setUserMfa(username: string, mfa: UserMfaRecord | undefined): boolean {
  if (username === 'root') {
    state.rootMfa = mfa ? { ...mfa, recoveryCodeHashes: mfa.recoveryCodeHashes ? [...mfa.recoveryCodeHashes] : undefined } : undefined;
    persistNow();
    return true;
  }
  const user = state.allowedUsers.find((entry) => entry.username === username.toLowerCase());
  if (!user) return false;
  user.mfa = mfa ? { ...mfa, recoveryCodeHashes: mfa.recoveryCodeHashes ? [...mfa.recoveryCodeHashes] : undefined } : undefined;
  persistNow();
  return true;
}

export function listPasskeysForUser(userId: string): PasskeyCredential[] {
  const normalized = userId === 'root' ? 'root' : userId.toLowerCase();
  return state.passkeys.filter((credential) => credential.userId === normalized).map((credential) => ({ ...credential, transports: credential.transports ? [...credential.transports] : undefined }));
}

export function getPasskeyById(id: string): PasskeyCredential | undefined {
  const credential = state.passkeys.find((candidate) => candidate.id === id);
  return credential ? { ...credential, transports: credential.transports ? [...credential.transports] : undefined } : undefined;
}

export function addPasskey(credential: PasskeyCredential): PasskeyCredential {
  if (state.passkeys.some((candidate) => candidate.id === credential.id)) throw new Error('passkey credential already exists');
  const normalized = { ...credential, userId: credential.userId === 'root' ? 'root' : credential.userId.toLowerCase(), transports: credential.transports ? [...credential.transports] : undefined };
  state.passkeys.push(normalized);
  persistNow();
  return { ...normalized, transports: normalized.transports ? [...normalized.transports] : undefined };
}

export function updatePasskey(id: string, patch: Partial<Pick<PasskeyCredential, 'counter' | 'lastUsedAt' | 'name'>>): PasskeyCredential | undefined {
  const credential = state.passkeys.find((candidate) => candidate.id === id);
  if (!credential) return undefined;
  Object.assign(credential, patch);
  persistNow();
  return { ...credential, transports: credential.transports ? [...credential.transports] : undefined };
}

export function deletePasskey(userId: string, id: string): boolean {
  const normalized = userId === 'root' ? 'root' : userId.toLowerCase();
  const index = state.passkeys.findIndex((credential) => credential.id === id && credential.userId === normalized);
  if (index === -1) return false;
  state.passkeys.splice(index, 1);
  persistNow();
  return true;
}

export function listRoles(): Role[] {
  return [...state.roles].sort((a, b) => a.position - b.position);
}

export function getRole(id: string): Role | undefined {
  return state.roles.find((r) => r.id === id);
}

export function getUserEffectivePermissions(username: string): bigint {
  const user = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  const billing = getBillingEntitlements(username.toLowerCase());
  const billingBits =
    (billing.decrypt ? PermissionFlag.requestDecrypt : 0n) |
    (billing.api ? PermissionFlag.createApiKeys : 0n);
  return effectiveBitsForRoleIds(user?.roleIds ?? [], state.roles) | billingBits;
}

export function getSessionVersion(username: string): number {
  if (username === 'root') return state.rootSessionVersion;
  return state.allowedUsers.find((u) => u.username === username.toLowerCase())?.sessionVersion ?? 0;
}

export function bumpSessionVersion(username: string): void {
  if (username === 'root') {
    state.rootSessionVersion += 1;
    state.activeSessions = state.activeSessions.filter((s) => s.sub !== 'root');
    persistNow();
    return;
  }
  const user = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!user) return;
  user.sessionVersion = (user.sessionVersion ?? 0) + 1;
  state.activeSessions = state.activeSessions.filter((s) => s.sub !== user.username);
  persistNow();
}

const SESSION_RECORD_THROTTLE_MS = 60_000;
const MAX_SESSIONS_PER_USER = 20;
const SESSION_RECORD_TTL_MS = 12 * 60 * 60 * 1000;

export function createSessionRecord(sub: string, userAgent: string | undefined, ip: string | undefined): ActiveSessionRecord {
  const record: ActiveSessionRecord = { id: randomUUID(), sub, createdAt: Date.now(), lastSeenAt: Date.now(), userAgent, ip };
  state.activeSessions.push(record);
  const forUser = state.activeSessions.filter((s) => s.sub === sub);
  if (forUser.length > MAX_SESSIONS_PER_USER) {
    const dropIds = new Set(forUser.slice(0, forUser.length - MAX_SESSIONS_PER_USER).map((s) => s.id));
    state.activeSessions = state.activeSessions.filter((s) => !dropIds.has(s.id));
  }
  persistNow();
  return record;
}

export function isSessionRecordActive(id: string): boolean {
  return state.activeSessions.some((s) => s.id === id);
}

export function touchSessionRecord(id: string): void {
  const record = state.activeSessions.find((s) => s.id === id);
  if (!record) return;
  const now = Date.now();
  if (now - record.lastSeenAt < SESSION_RECORD_THROTTLE_MS) return;
  record.lastSeenAt = now;
  dirty = true;
}

export function listSessionsForUser(sub: string): ActiveSessionRecord[] {
  return state.activeSessions.filter((s) => s.sub === sub).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function revokeSessionRecord(id: string, sub: string): boolean {
  const idx = state.activeSessions.findIndex((s) => s.id === id && s.sub === sub);
  if (idx === -1) return false;
  state.activeSessions.splice(idx, 1);
  persistNow();
  return true;
}

export function revokeOtherSessionRecords(sub: string, keepId: string): number {
  const before = state.activeSessions.length;
  state.activeSessions = state.activeSessions.filter((s) => s.sub !== sub || s.id === keepId);
  const removed = before - state.activeSessions.length;
  if (removed > 0) persistNow();
  return removed;
}

export function startSessionSweeper(): void {
  sessionSweepTimer ??= setInterval(() => {
    const now = Date.now();
    const before = state.activeSessions.length;
    state.activeSessions = state.activeSessions.filter((s) => now - s.lastSeenAt < SESSION_RECORD_TTL_MS);
    if (state.activeSessions.length !== before) persistNow();
  }, 60_000).unref();
}

const ACTIVITY_THROTTLE_MS = 60_000;

export function recordUserActivity(username: string): void {
  if (username === 'root') return;
  const user = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!user) return;
  const now = Date.now();
  if (user.lastActiveAt && now - user.lastActiveAt < ACTIVITY_THROTTLE_MS) return;
  user.lastActiveAt = now;
  dirty = true;
}

export function wouldOrphanPermission(username: string, flag: bigint, hypotheticalRoleIds: string[] | null): boolean {
  const lower = username.toLowerCase();
  const currentBits = getUserEffectivePermissions(lower);
  if (!currentBits || !hasPermission(currentBits, flag)) return false;
  const othersHaveIt = state.allowedUsers.some(
    (u) => u.username !== lower && hasPermission(effectiveBitsForRoleIds(u.roleIds, state.roles), flag),
  );
  if (othersHaveIt) return false;
  const newBits = effectiveBitsForRoleIds(hypotheticalRoleIds ?? [], state.roles);
  return !hasPermission(newBits, flag);
}

function wouldOrphanManageUsersViaRole(roleId: string, newBits: bigint | null): boolean {
  const before = state.allowedUsers.some((u) => hasPermission(effectiveBitsForRoleIds(u.roleIds, state.roles), PermissionFlag.manageUsers));
  if (!before) return false;
  const simulatedRoles =
    newBits === null
      ? state.roles.filter((r) => r.id !== roleId)
      : state.roles.map((r) => (r.id === roleId ? { ...r, permissions: serializeBits(newBits) } : r));
  const after = state.allowedUsers.some((u) => hasPermission(effectiveBitsForRoleIds(u.roleIds, simulatedRoles), PermissionFlag.manageUsers));
  return !after;
}

function roleAssignmentDiff(before: string[], after: string[]): string {
  const added = after.filter((id) => !before.includes(id)).map((id) => getRole(id)?.name ?? id);
  const removed = before.filter((id) => !after.includes(id)).map((id) => getRole(id)?.name ?? id);
  const parts = [...added.map((n) => `+${n}`), ...removed.map((n) => `-${n}`)];
  return parts.length > 0 ? parts.join(', ') : '(no change)';
}

export function recordAudit(actor: string, action: AuditAction, target: string, detail?: string): void {
  state.auditLog.unshift({ id: randomUUID(), ts: Date.now(), actor, action, target, detail });
  if (state.auditLog.length > MAX_AUDIT_LOG) state.auditLog.length = MAX_AUDIT_LOG;
  persistNow();
}

export function getAuditLog(limit = 100): AuditLogEntry[] {
  return state.auditLog.slice(0, limit);
}

export function getAuditLogPage(offset = 0, limit = 100): { entries: AuditLogEntry[]; total: number } {
  return { entries: state.auditLog.slice(Math.max(offset, 0), Math.max(offset, 0) + Math.max(limit, 1)), total: state.auditLog.length };
}

function sanitizeRoleIds(roleIds: string[]): string[] {
  return [...new Set(roleIds)].filter((id) => state.roles.some((r) => r.id === id && !r.isDefault));
}

export function addAllowedUser(username: string, roleIds: string[], actor: string): AllowedUser {
  const lower = username.toLowerCase();
  const sanitized = sanitizeRoleIds(roleIds);
  const existing = state.allowedUsers.find((u) => u.username === lower);
  if (existing) {
    const detail = roleAssignmentDiff(existing.roleIds, sanitized);
    existing.roleIds = sanitized;
    persistNow();
    recordAudit(actor, 'user.update', lower, detail);
    return existing;
  }
  const record: AllowedUser = { username: lower, roleIds: sanitized, addedAt: Date.now() };
  state.allowedUsers.push(record);
  persistNow();
  recordAudit(actor, 'user.add', lower, roleAssignmentDiff([], sanitized));
  return record;
}

export function getDiscordGuilds(): DiscordGuildConfiguration[] {
  return state.discordGuilds;
}

export function getDiscordGuildIds(): string[] {
  return state.discordGuilds.map((guild) => guild.id);
}

export function setDiscordGuilds(guilds: DiscordGuildConfiguration[], actor: string): void {
  state.discordGuilds = [...new Map(guilds.filter((guild) => guild.id).map((guild) => [guild.id, guild])).values()];
  const selectedGuildIds = new Set(state.discordGuilds.map((guild) => guild.id));
  state.discordRolePerks = state.discordRolePerks.filter((perk) => selectedGuildIds.has(perk.guildId));
  persistNow();
  recordAudit(actor, 'role.update', 'discord-guilds', state.discordGuilds.length ? `set to ${state.discordGuilds.map((guild) => guild.id).join(', ')}` : 'cleared');
}

export function setDiscordGuildIds(guildIds: string[], actor: string): void {
  setDiscordGuilds(guildIds.map((id) => ({ id, name: id, icon: null })), actor);
}

export function getDiscordRolePerks(): DiscordRolePerk[] {
  return state.discordRolePerks;
}

export function createDiscordRolePerk(
  guild: DiscordGuildConfiguration,
  discordRole: DiscordGuildRoleConfiguration,
  appRoleId: string,
  actor: string,
): DiscordRolePerk {
  const perk: DiscordRolePerk = {
    id: randomUUID(),
    guildId: guild.id,
    guildName: guild.name,
    guildIcon: guild.icon,
    discordRoleId: discordRole.id,
    discordRoleName: discordRole.name,
    discordRoleColor: discordRole.color,
    appRoleId,
    createdAt: Date.now(),
  };
  state.discordRolePerks.push(perk);
  persistNow();
  recordAudit(actor, 'role.update', appRoleId, `Discord role perk added: ${discordRole.name}`);
  return perk;
}

export function deleteDiscordRolePerk(id: string, actor: string): boolean {
  const before = state.discordRolePerks.length;
  state.discordRolePerks = state.discordRolePerks.filter((p) => p.id !== id);
  const changed = state.discordRolePerks.length !== before;
  if (changed) {
    persistNow();
    recordAudit(actor, 'role.update', id, 'Discord role perk removed');
  }
  return changed;
}

export function syncDiscordPerkRoles(userId: string, memberships: DiscordGuildMembership[]): void {
  let user = state.allowedUsers.find((u) => u.username === userId.toLowerCase());
  if (!user) {
    user = { username: userId.toLowerCase(), roleIds: [], addedAt: Date.now() };
    state.allowedUsers.push(user);
  }

  const roleIdsByGuild = new Map(memberships.map((membership) => [membership.guildId, membership.roleIds]));
  const grantedAppRoleIds = [
    ...new Set(
      state.discordRolePerks
        .filter((perk) => roleIdsByGuild.get(perk.guildId)?.includes(perk.discordRoleId))
        .map((perk) => perk.appRoleId),
    ),
  ];
  const unverifiedAppRoleIds = new Set(
    state.discordRolePerks
      .filter((perk) => roleIdsByGuild.get(perk.guildId) === undefined)
      .map((perk) => perk.appRoleId),
  );
  const previouslyGranted = user.discordPerkRoleIds ?? [];
  if (grantedAppRoleIds.length === 0 && previouslyGranted.length === 0) return;

  const retainedAppRoleIds = previouslyGranted.filter((id) => unverifiedAppRoleIds.has(id));
  const nextDiscordPerkRoleIds = [...new Set([...grantedAppRoleIds, ...retainedAppRoleIds])];
  const withoutStalePerks = user.roleIds.filter((id) => !previouslyGranted.includes(id) || nextDiscordPerkRoleIds.includes(id));
  user.roleIds = sanitizeRoleIds([...withoutStalePerks, ...nextDiscordPerkRoleIds]);
  user.discordPerkRoleIds = nextDiscordPerkRoleIds;
  persistNow();
}

export function mergeUserAccounts(targetUsername: string, sourceUsername: string, actor: string): boolean {
  const targetId = targetUsername.toLowerCase();
  const sourceId = sourceUsername.toLowerCase();
  if (targetId === sourceId) return false;

  const source = state.allowedUsers.find((user) => user.username === sourceId);
  if (!source) return false;
  const target = state.allowedUsers.find((user) => user.username === targetId);

  if (target) {
    target.roleIds = sanitizeRoleIds([...target.roleIds, ...source.roleIds]);
    target.addedAt = Math.min(target.addedAt, source.addedAt);
    target.lastActiveAt = Math.max(target.lastActiveAt ?? 0, source.lastActiveAt ?? 0) || undefined;
    target.priority = Math.max(target.priority ?? 0, source.priority ?? 0);
    target.sessionVersion = Math.max(target.sessionVersion ?? 0, source.sessionVersion ?? 0) + 1;
    state.allowedUsers = state.allowedUsers.filter((user) => user !== source);
  } else {
    source.username = targetId;
    source.sessionVersion = (source.sessionVersion ?? 0) + 1;
  }

  for (const key of state.apiKeys) {
    if (key.ownerId === sourceId) key.ownerId = targetId;
  }
  for (const entry of state.jobHistory) {
    if (entry.queuedBy === sourceId) entry.queuedBy = targetId;
  }
  for (const subscription of state.testFlightSubscriptions) {
    if (subscription.requestedBy === sourceId) subscription.requestedBy = targetId;
  }
  const sourcePrefs = state.userPrefs[sourceId];
  const targetPrefs = state.userPrefs[targetId];
  if (sourcePrefs || targetPrefs) state.userPrefs[targetId] = { ...(sourcePrefs ?? {}), ...(targetPrefs ?? {}) };
  delete state.userPrefs[sourceId];

  const subscriptions = [...(state.pushSubscriptions[targetId] ?? []), ...(state.pushSubscriptions[sourceId] ?? [])];
  if (subscriptions.length > 0) {
    state.pushSubscriptions[targetId] = subscriptions.filter(
      (subscription, index, all) => all.findIndex((candidate) => candidate.endpoint === subscription.endpoint) === index,
    );
  }
  delete state.pushSubscriptions[sourceId];

  persistNow();
  recordAudit(actor, 'user.update', targetId, `merged account ${sourceId}`);
  return true;
}

export function updateAllowedUserRoles(username: string, roleIds: string[], actor: string): AllowedUser | undefined {
  const existing = state.allowedUsers.find((u) => u.username === username.toLowerCase());
  if (!existing) return undefined;
  const sanitized = sanitizeRoleIds(roleIds);
  const detail = roleAssignmentDiff(existing.roleIds, sanitized);
  existing.roleIds = sanitized;
  persistNow();
  recordAudit(actor, 'user.update', existing.username, detail);
  return existing;
}

export interface CreateRoleInput {
  name: string;
  color: string;
  permissions: string;
}

export function createRole(input: CreateRoleInput, actor: string): Role {
  const now = Date.now();
  const position = Math.max(0, ...state.roles.map((r) => r.position)) + 1;
  const role: Role = {
    id: randomUUID(),
    name: input.name,
    color: input.color,
    permissions: serializeBits(parseBits(input.permissions)),
    position,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
  state.roles.push(role);
  persistNow();
  recordAudit(actor, 'role.add', role.id, role.name);
  return role;
}

export interface UpdateRoleInput {
  name?: string;
  color?: string;
  permissions?: string;
}

export function updateRole(id: string, patch: UpdateRoleInput, actor: string): { ok: boolean; role?: Role; error?: string } {
  const role = state.roles.find((r) => r.id === id);
  if (!role) return { ok: false, error: 'role not found' };
  if (patch.permissions !== undefined) {
    const newBits = parseBits(patch.permissions);
    if (wouldOrphanManageUsersViaRole(id, newBits)) {
      return { ok: false, error: 'this would leave nobody able to manage users - grant it to someone else first' };
    }
    role.permissions = serializeBits(newBits);
  }
  if (patch.name !== undefined && !role.isDefault) role.name = patch.name;
  if (patch.color !== undefined) role.color = patch.color;
  role.updatedAt = Date.now();
  persistNow();
  recordAudit(actor, 'role.update', role.id, role.name);
  return { ok: true, role };
}

export function deleteRole(id: string, actor: string): { ok: boolean; error?: string } {
  const role = state.roles.find((r) => r.id === id);
  if (!role) return { ok: false, error: 'role not found' };
  if (role.isDefault) return { ok: false, error: "the @everyone role can't be deleted" };
  if (wouldOrphanManageUsersViaRole(id, null)) {
    return { ok: false, error: 'this would leave nobody able to manage users - grant it to someone else first' };
  }
  state.roles = state.roles.filter((r) => r.id !== id);
  for (const u of state.allowedUsers) u.roleIds = u.roleIds.filter((rid) => rid !== id);
  persistNow();
  recordAudit(actor, 'role.remove', id, role.name);
  return { ok: true };
}

export function reorderRoles(orderedIds: string[], actor: string): boolean {
  const nonDefaultIds = orderedIds.filter((id) => id !== DEFAULT_ROLE_ID);
  const nonDefaultRoles = state.roles.filter((r) => !r.isDefault);
  if (nonDefaultIds.length !== nonDefaultRoles.length || !nonDefaultRoles.every((r) => nonDefaultIds.includes(r.id))) return false;
  nonDefaultIds.forEach((id, idx) => {
    const role = state.roles.find((r) => r.id === id);
    if (role) role.position = idx + 1;
  });
  persistNow();
  recordAudit(actor, 'role.update', 'reorder', 'positions changed');
  return true;
}

export function removeAllowedUser(username: string, actor: string): boolean {
  const lower = username.toLowerCase();
  const user = state.allowedUsers.find((u) => u.username === lower);
  if (!user) return false;
  const changed = user.roleIds.length > 0 || (user.priority ?? 0) !== 0 || (user.discordPerkRoleIds?.length ?? 0) > 0;
  user.roleIds = [];
  user.discordPerkRoleIds = [];
  user.priority = 0;
  if (changed) {
    persistNow();
    recordAudit(actor, 'user.remove', lower, 'role assignments cleared');
  }
  return changed;
}

export function deleteUserPersonalData(username: string): boolean {
  const lower = username.toLowerCase();
  const existed = state.allowedUsers.some((user) => user.username === lower);
  if (!existed || lower === 'root') return false;
  state.allowedUsers = state.allowedUsers.filter((user) => user.username !== lower);
  state.activeSessions = state.activeSessions.filter((session) => session.sub !== lower);
  state.passkeys = state.passkeys.filter((credential) => credential.userId !== lower);
  state.apiKeys = state.apiKeys.filter((key) => key.ownerId !== lower);
  state.jobHistory = state.jobHistory.filter((entry) => entry.queuedBy?.toLowerCase() !== lower);
  state.userPrefs = Object.fromEntries(Object.entries(state.userPrefs).filter(([userId]) => userId !== lower));
  state.pushSubscriptions = Object.fromEntries(Object.entries(state.pushSubscriptions).filter(([userId]) => userId !== lower));
  state.notifications = state.notifications.filter((notification) => notification.userId.toLowerCase() !== lower);
  state.testFlightSubscriptions = state.testFlightSubscriptions.filter(
    (subscription) => subscription.requestedBy !== lower || subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID,
  );
  for (const keyId of Object.keys(state.apiKeyUsage)) {
    if (!state.apiKeys.some((key) => key.id === keyId)) delete state.apiKeyUsage[keyId];
  }
  for (const keyId of Object.keys(state.apiKeyBundleUsage)) {
    if (!state.apiKeys.some((key) => key.id === keyId)) delete state.apiKeyBundleUsage[keyId];
  }
  for (const keyId of Object.keys(state.apiKeyOutcomeUsage)) {
    if (!state.apiKeys.some((key) => key.id === keyId)) delete state.apiKeyOutcomeUsage[keyId];
  }
  state.auditLog = state.auditLog.map((entry) => ({
    ...entry,
    actor: entry.actor.toLowerCase() === lower ? 'deleted-user' : entry.actor,
    target: entry.target.toLowerCase() === lower ? 'deleted-user' : entry.target,
  }));
  persistNow();
  return true;
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
    lastUsedIp: k.lastUsedIp,
    allowedBundleIds: k.allowedBundleIds,
    dailyLimit: k.dailyLimit,
    maxConcurrent: k.maxConcurrent,
    allowTestFlight: k.allowTestFlight ?? true,
    priority: k.priority ?? 0,
    previousKeyValidUntil: k.previousHash && k.previousHashExpiresAt && k.previousHashExpiresAt > Date.now() ? k.previousHashExpiresAt : undefined,
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
  allowTestFlight?: boolean,
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
    allowTestFlight,
  };
  state.apiKeys.push(record);
  persistNow();
  return { id: record.id, name: record.name, key, createdAt: record.createdAt, expiresAt: record.expiresAt };
}

export function requestApiKey(
  name: string,
  ownerId: string,
  expiresInDays?: number,
  allowedBundleIds?: string[],
  dailyLimit?: number,
  allowTestFlight?: boolean,
) {
  const record: ApiKeyRecord = {
    id: randomUUID(),
    name,
    ownerId,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: expiresAtFromDays(expiresInDays),
    allowedBundleIds: sanitizeBundleIds(allowedBundleIds),
    dailyLimit,
    allowTestFlight,
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

export function regenerateApiKey(id: string, requesterId: string, graceMinutes = 0): boolean {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record || record.status !== 'approved' || record.ownerId !== requesterId) return false;
  if (record.hash && graceMinutes > 0) {
    record.previousHash = record.hash;
    record.previousHashExpiresAt = Date.now() + graceMinutesToMs(graceMinutes);
  } else {
    record.previousHash = undefined;
    record.previousHashExpiresAt = undefined;
  }
  const key = randomBytes(32).toString('hex');
  record.hash = hashKey(key);
  record.pendingReveal = key;
  persistNow();
  return true;
}

function graceMinutesToMs(graceMinutes: number): number {
  return Math.min(graceMinutes, 24 * 60) * 60_000;
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
  delete state.apiKeyOutcomeUsage[id];
  persistNow();
  return true;
}

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

export function bulkSetApiKeyAllowedBundleIds(ids: string[], allowedBundleIds: string[] | undefined): string[] {
  const updated: string[] = [];
  for (const id of ids) {
    const record = state.apiKeys.find((k) => k.id === id);
    if (!record) continue;
    record.allowedBundleIds = allowedBundleIds;
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

export function verifyApiKey(candidate: string, ip?: string): ApiKeyAuthResult | undefined | 'rate-limited' {
  if (safeEqualStr(candidate, config.apiKey)) return {};

  const hash = hashKey(candidate);
  const record = state.apiKeys.find((k) => {
    if (k.status !== 'approved') return false;
    if (k.hash === hash) return true;
    return k.previousHash === hash && !!k.previousHashExpiresAt && Date.now() < k.previousHashExpiresAt;
  });
  if (!record) return undefined;
  if (record.expiresAt && Date.now() > record.expiresAt) return undefined;
  if (record.ownerId !== 'root') {
    const permissions = getUserEffectivePermissions(record.ownerId);
    if (!hasPermission(permissions, PermissionFlag.createApiKeys)) return undefined;
  }
  if (record.dailyLimit && todayUsageCount(record.id) >= record.dailyLimit) return 'rate-limited';

  record.lastUsedAt = Date.now();
  if (ip) record.lastUsedIp = ip;
  recordApiKeyUsage(record.id);
  dirty = true;
  const billingPriority = record.ownerId === 'root' ? 0 : getBillingEntitlements(record.ownerId).priority;
  return {
    allowedBundleIds: record.allowedBundleIds,
    ownerId: record.ownerId,
    priority: billingPriority > 0 ? Math.max(record.priority ?? 0, billingPriority) : (record.priority ?? 0),
    keyId: record.id,
    allowTestFlight: record.allowTestFlight ?? true,
  };
}

const MAX_TRACKED_BUNDLES_PER_KEY = 100;

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

const MAX_TRACKED_OUTCOMES_PER_KEY = 30;

export function recordApiKeyOutcome(id: string, method: string, path: string, status: number): void {
  const route = `${method} ${path}`;
  const perKey = state.apiKeyOutcomeUsage[id] ?? {};
  const outcome = perKey[route] ?? { route, success: 0, clientError: 0, serverError: 0, lastAt: Date.now() };
  if (status < 400) outcome.success += 1;
  else if (status < 500) outcome.clientError += 1;
  else outcome.serverError += 1;
  outcome.lastAt = Date.now();
  perKey[route] = outcome;
  if (Object.keys(perKey).length > MAX_TRACKED_OUTCOMES_PER_KEY) {
    const oldest = Object.values(perKey).sort((a, b) => a.lastAt - b.lastAt)[0]?.route;
    if (oldest) delete perKey[oldest];
  }
  state.apiKeyOutcomeUsage[id] = perKey;
  dirty = true;
}

export function getApiKeyOutcomeUsage(id: string, limit = 10): ApiKeyOutcomeUsage[] {
  return Object.values(state.apiKeyOutcomeUsage[id] ?? {})
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit);
}

const MAX_GITHUB_BUDGET_TELEMETRY = 200;

export function recordGitHubBudgetTelemetry(entry: Omit<GitHubBudgetTelemetryEntry, 'id' | 'ts'>): void {
  state.githubBudgetTelemetry.unshift({ id: randomUUID(), ts: Date.now(), ...entry });
  if (state.githubBudgetTelemetry.length > MAX_GITHUB_BUDGET_TELEMETRY) state.githubBudgetTelemetry.length = MAX_GITHUB_BUDGET_TELEMETRY;
  dirty = true;
}

export function getGitHubBudgetTelemetry(limit = 30): GitHubBudgetTelemetryEntry[] {
  return state.githubBudgetTelemetry.slice(0, limit);
}

export function getUserPriority(username: string): number {
  if (username === 'root') return 0;
  const manualPriority = state.allowedUsers.find((u) => u.username === username.toLowerCase())?.priority ?? 0;
  const billingPriority = getBillingEntitlements(username.toLowerCase()).priority;
  return billingPriority > 0 ? Math.max(manualPriority, billingPriority) : manualPriority;
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

export function setApiKeyMaxConcurrent(id: string, maxConcurrent: number | undefined): ApiKeyRecord | undefined {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record) return undefined;
  record.maxConcurrent = maxConcurrent && maxConcurrent > 0 ? Math.floor(maxConcurrent) : undefined;
  persistNow();
  return record;
}

export function setApiKeyAllowTestFlight(id: string, allowTestFlight: boolean): ApiKeyRecord | undefined {
  const record = state.apiKeys.find((k) => k.id === id);
  if (!record) return undefined;
  record.allowTestFlight = allowTestFlight;
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
  apiKeySweepTimer ??= setInterval(() => {
    const now = Date.now();
    const before = state.apiKeys.length;
    state.apiKeys = state.apiKeys.filter((k) => !(k.expiresAt && now > k.expiresAt));
    if (state.apiKeys.length !== before) persistNow();
  }, 60_000).unref();
}

export function getEffectiveSettings(): SchedulerSettings {
  const legacySettings = state.settings as Record<string, unknown>;
  const legacyDispatchSuccess = typeof legacySettings.notifyOnDispatchSuccess === 'boolean' ? legacySettings.notifyOnDispatchSuccess : undefined;
  const legacyDispatchFailure = typeof legacySettings.notifyOnDispatchFailure === 'boolean' ? legacySettings.notifyOnDispatchFailure : undefined;
  const legacyAutomationSuccess = [legacySettings.notifyOnAppStoreAutomationSuccess, legacySettings.notifyOnTestFlightAutomationSuccess]
    .filter((value): value is boolean => typeof value === 'boolean')
    .some(Boolean);
  const legacyAutomationFailure = [legacySettings.notifyOnAppStoreAutomationFailure, legacySettings.notifyOnTestFlightAutomationFailure]
    .filter((value): value is boolean => typeof value === 'boolean')
    .some(Boolean);
  return {
    notifyWebhookUrl: state.settings.notifyWebhookUrl ?? config.notifyWebhookUrl,
    notifyFormat: state.settings.notifyFormat ?? 'embed',
    notifySuccessMode:
      state.settings.notifySuccessMode === 'daily' || state.settings.notifySuccessMode === 'weekly'
        ? state.settings.notifySuccessMode
        : 'instant',
    notifyQuietHoursStart:
      typeof state.settings.notifyQuietHoursStart === 'string' && /^\d{2}:\d{2}$/.test(state.settings.notifyQuietHoursStart)
        ? state.settings.notifyQuietHoursStart
        : '',
    notifyQuietHoursEnd:
      typeof state.settings.notifyQuietHoursEnd === 'string' && /^\d{2}:\d{2}$/.test(state.settings.notifyQuietHoursEnd)
        ? state.settings.notifyQuietHoursEnd
        : '',
    notifyOnKeyRequest: state.settings.notifyOnKeyRequest ?? true,
    notifyOnAutomationSuccess: state.settings.notifyOnAutomationSuccess ?? legacyDispatchSuccess ?? legacyAutomationSuccess ?? true,
    notifyOnAutomationFailure: state.settings.notifyOnAutomationFailure ?? legacyDispatchFailure ?? legacyAutomationFailure ?? true,
    notifyOnKeyExpiringSoon: state.settings.notifyOnKeyExpiringSoon ?? true,
    notifyOnDeviceOffline: state.settings.notifyOnDeviceOffline ?? true,
    notifyOnDeviceBatteryHot: state.settings.notifyOnDeviceBatteryHot ?? true,
    notifyOnDeviceBatteryLow: state.settings.notifyOnDeviceBatteryLow ?? true,
    notifyOnDiskFull: state.settings.notifyOnDiskFull ?? true,
    notifyOnDeviceStorageLow: state.settings.notifyOnDeviceStorageLow ?? true,
    notifyOnTestFlightBridgeDown: state.settings.notifyOnTestFlightBridgeDown ?? true,
    notifyOnJobCompleted: state.settings.notifyOnJobCompleted ?? false,
    notifyOnQueueSloBreach: state.settings.notifyOnQueueSloBreach ?? true,
    schedulerRetryCount: state.settings.schedulerRetryCount ?? 0,
    deviceOfflineAlertMinutes: state.settings.deviceOfflineAlertMinutes ?? 15,
    batteryHotAlertC: state.settings.batteryHotAlertC ?? 45,
    batteryLowAlertPercent: state.settings.batteryLowAlertPercent ?? 10,
    diskFullAlertPercent: state.settings.diskFullAlertPercent ?? 90,
    deviceStorageAlertPercent: state.settings.deviceStorageAlertPercent ?? 90,
    testFlightBridgeAlertMinutes: state.settings.testFlightBridgeAlertMinutes ?? 15,
    jobHistoryRetentionDays: state.settings.jobHistoryRetentionDays ?? 0,
    maintenanceMode: state.settings.maintenanceMode ?? false,
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

    repo: legacy.watchAppRepo || legacy.ghDispatchRepo || config.watchAppRepo || config.ghDispatchRepo,
    ghWorkflowFile: legacy.ghWorkflowFile || config.ghWorkflowFile,
    pollCron: legacy.pollCron || config.pollCron,
  };
}

export function getEffectiveWatches(): AppWatch[] {
  if (state.watches.length > 0) return state.watches;
  const legacy = getLegacySingleWatchFields();
  return legacy ? [{ id: 'default', enabled: true, createdAt: 0, updatedAt: 0, ...legacy }] : [];
}

export function listWatches(): AppWatch[] {
  return getEffectiveWatches();
}

export function isBundleWatched(bundleId: string): boolean {
  return getEffectiveWatches().some((w) => w.bundleId === bundleId);
}

export function getWatch(id: string): AppWatch | undefined {
  return getEffectiveWatches().find((w) => w.id === id);
}

function hasEnabledWatchWithBundleId(bundleId: string, excludeId?: string): boolean {
  return getEffectiveWatches().some((w) => w.enabled && w.bundleId === bundleId && w.id !== excludeId);
}

function materializeWatches(): void {
  if (state.watches.length > 0) return;
  const legacy = getLegacySingleWatchFields();
  if (legacy) state.watches = [{ id: 'default', enabled: true, createdAt: 0, updatedAt: 0, ...legacy }];
}

export interface CreateWatchInput {
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

export function getWatchDispatchTargets(watch: Pick<AppWatch, 'repo' | 'ghWorkflowFile' | 'dispatchTargets'>): DispatchTarget[] {
  const candidates = watch.dispatchTargets?.length
    ? watch.dispatchTargets
    : [{ repo: watch.repo, ghWorkflowFile: watch.ghWorkflowFile }];
  const seen = new Set<string>();
  return candidates
    .map((target) => ({
      repo: target.repo.trim(),
      ghWorkflowFile: target.ghWorkflowFile.trim(),
      mode: target.mode,
      ref: target.ref?.trim() || undefined,
      inputs: target.inputs,
    }))
    .filter((target) => {
      const key = JSON.stringify([target.repo, target.ghWorkflowFile, target.mode ?? 'repository_dispatch', target.ref ?? '', target.inputs ?? {}]);
      if (!target.repo || !target.ghWorkflowFile || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizedWatchInput(input: CreateWatchInput): Pick<CreateWatchInput, 'repo' | 'ghWorkflowFile' | 'dispatchTargets'> {
  const targets = getWatchDispatchTargets(input);
  const primary = targets[0] ?? { repo: input.repo.trim(), ghWorkflowFile: input.ghWorkflowFile.trim() };
  const preserveTargets = targets.length > 1 || targets.some((target) => target.mode === 'workflow_dispatch' || target.ref || Object.keys(target.inputs ?? {}).length > 0);
  return {
    repo: primary.repo,
    ghWorkflowFile: primary.ghWorkflowFile,
    dispatchTargets: preserveTargets ? targets : undefined,
  };
}

export function createWatch(input: CreateWatchInput, actor: string): { ok: boolean; watch?: AppWatch; error?: string } {
  materializeWatches();
  if (input.enabled !== false && hasEnabledWatchWithBundleId(input.bundleId)) {
    return { ok: false, error: `another enabled watch already targets ${input.bundleId}` };
  }
  const now = Date.now();
  const dispatch = normalizedWatchInput(input);
  const watch: AppWatch = {
    id: randomUUID(),
    bundleId: input.bundleId,
    ...dispatch,
    pollCron: input.pollCron,
    enabled: input.enabled ?? true,
    webhookUrl: input.webhookUrl,
    testFlightPolicy: input.testFlightPolicy,
    testFlightTrain: input.testFlightTrain,
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
  const merged = { ...watch, ...patch } as CreateWatchInput;
  const dispatch = normalizedWatchInput(merged);
  Object.assign(watch, patch, dispatch, { updatedAt: Date.now() });
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
  return watch.enabled && watch.bundleId !== '' && getWatchDispatchTargets(watch).length > 0 && config.ghToken !== '';
}

export function getWatchConfigIssues(watch: AppWatch): string[] {
  const hasRepo = Boolean(watch.repo || watch.dispatchTargets?.some((target) => target.repo.trim()));
  const fieldsSet = [watch.bundleId, hasRepo].filter(Boolean).length;
  const issues: string[] = [];

  if (fieldsSet > 0 && fieldsSet < 2) {
    const missing = [!watch.bundleId && 'watch bundle ID', !hasRepo && 'repo'].filter((v): v is string => typeof v === 'string');
    issues.push(`Watch is partially configured - still missing ${missing.join(', ')}.`);
  }

  if (fieldsSet === 2 && config.ghToken === '') {
    issues.push('A dispatch target is configured but GH_TOKEN is not set - this watch will never actually run.');
  }

  if (watch.testFlightPolicy === 'train' && !watch.testFlightTrain?.trim()) {
    issues.push('A TestFlight train is required when the train policy is selected.');
  }

  return issues;
}

export function getEffectiveDevices(): DeviceRecord[] {
  return state.devices;
}

export function listDevices(): DeviceRecord[] {
  return getEffectiveDevices();
}

export function getDevice(id: string): DeviceRecord | undefined {
  return getEffectiveDevices().find((d) => d.id === id);
}

export function getPrimaryDevice(): DeviceRecord | undefined {
  const devices = getEffectiveDevices().filter((d) => d.enabled);
  return devices.find((d) => d.isPrimary) ?? devices[0];
}

export interface CreateTestFlightSubscriptionInput {
  url: string;
  inviteCode: string;
  requestedBy: string;
  status: TestFlightSubscriptionStatus;
  appId?: number;
  bundleId?: string;
  displayName?: string;
  iconUrl?: string;
  sellerName?: string;
  category?: string;
}

function cloneTestFlightSubscription(subscription: TestFlightSubscription): TestFlightSubscription {
  return { ...subscription, devices: subscription.devices.map((device) => ({ ...device })) };
}

function notificationForSubscription(userId: string, title: string, message: string, severity: NotificationSeverity): void {
  recordNotification({ userId, title, message, severity, href: '/?tab=settings&stab=testflight' });
}

export function getTestFlightSubscriptions(): TestFlightSubscription[] {
  return state.testFlightSubscriptions.map(cloneTestFlightSubscription);
}

export function getTestFlightSubscription(id: string): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  return subscription ? cloneTestFlightSubscription(subscription) : undefined;
}

export function listTestFlightSubscriptionsForUser(userId: string): TestFlightSubscription[] {
  const lower = userId.toLowerCase();
  return state.testFlightSubscriptions.filter((subscription) => subscription.requestedBy === lower).map(cloneTestFlightSubscription);
}

export function findTestFlightSubscriptionByInviteCode(inviteCode: string): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.inviteCode === inviteCode && entry.status !== 'withdrawn');
  return subscription ? cloneTestFlightSubscription(subscription) : undefined;
}

export function ensureTestFlightSubscriptionDevices(id: string): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription) return undefined;
  if (subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return cloneTestFlightSubscription(subscription);
  const known = new Set(subscription.devices.map((device) => device.deviceId));
  const now = Date.now();
  for (const device of getEffectiveDevices().filter((entry) => entry.enabled)) {
    if (known.has(device.id)) continue;
    subscription.devices.push({ deviceId: device.id, status: 'pending' });
  }
  subscription.updatedAt = now;
  persistNow();
  return cloneTestFlightSubscription(subscription);
}

export function createTestFlightSubscription(input: CreateTestFlightSubscriptionInput, actor: string): TestFlightSubscription {
  if (input.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) throw new Error('Discord TestFlight access is protected and cannot be changed');
  const existing = findTestFlightSubscriptionByInviteCode(input.inviteCode);
  if (existing) return existing;
  const now = Date.now();
  const subscription: TestFlightSubscription = {
    id: randomUUID(),
    url: input.url,
    inviteCode: input.inviteCode,
    requestedBy: input.requestedBy.toLowerCase(),
    status: input.status,
    appId: input.appId,
    bundleId: input.bundleId,
    displayName: input.displayName,
    iconUrl: input.iconUrl,
    sellerName: input.sellerName,
    category: input.category,
    createdAt: now,
    updatedAt: now,
    devices: getEffectiveDevices().filter((device) => device.enabled).map((device) => ({ deviceId: device.id, status: 'pending' })),
    devicePolicy: 'all-enabled',
  };
  state.testFlightSubscriptions.unshift(subscription);
  persistNow();
  recordAudit(actor, 'testflight-subscription.add', subscription.id, `${subscription.url} (${subscription.status})`);
  notificationForSubscription(
    subscription.requestedBy,
    'TestFlight subscription submitted',
    subscription.status === 'approved' ? `${subscription.displayName ?? subscription.url} is being synchronized.` : `${subscription.displayName ?? subscription.url} is awaiting approval.`,
    subscription.status === 'approved' ? 'info' : 'success',
  );
  return cloneTestFlightSubscription(subscription);
}

export function approveTestFlightSubscription(id: string, actor: string): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription || subscription.status !== 'pending' || subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return undefined;
  const now = Date.now();
  subscription.status = 'approved';
  subscription.approvedAt = now;
  subscription.approvedBy = actor;
  subscription.deniedAt = undefined;
  subscription.deniedBy = undefined;
  subscription.updatedAt = now;
  ensureTestFlightSubscriptionDevices(id);
  persistNow();
  recordAudit(actor, 'testflight-subscription.approve', id, subscription.url);
  notificationForSubscription(subscription.requestedBy, 'TestFlight subscription approved', `${subscription.displayName ?? subscription.url} is being synchronized to enabled devices.`, 'success');
  return cloneTestFlightSubscription(subscription);
}

export function denyTestFlightSubscription(id: string, actor: string): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription || subscription.status !== 'pending' || subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return undefined;
  const now = Date.now();
  subscription.status = 'denied';
  subscription.deniedAt = now;
  subscription.deniedBy = actor;
  subscription.updatedAt = now;
  persistNow();
  recordAudit(actor, 'testflight-subscription.deny', id, subscription.url);
  notificationForSubscription(subscription.requestedBy, 'TestFlight subscription denied', subscription.displayName ?? subscription.url, 'warning');
  return cloneTestFlightSubscription(subscription);
}

export function withdrawTestFlightSubscription(id: string, actor: string, detail?: string): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription) return undefined;
  if (subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return cloneTestFlightSubscription(subscription);
  if (subscription.status === 'withdrawn') return cloneTestFlightSubscription(subscription);
  const now = Date.now();
  subscription.status = 'withdrawn';
  subscription.withdrawnAt = now;
  subscription.withdrawnBy = actor;
  subscription.updatedAt = now;
  persistNow();
  recordAudit(actor, 'testflight-subscription.remove', id, detail ?? subscription.url);
  return cloneTestFlightSubscription(subscription);
}

export function updateTestFlightSubscriptionDevice(
  id: string,
  deviceId: string,
  patch: Partial<TestFlightSubscriptionDevice>,
): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription) return undefined;
  if (subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return cloneTestFlightSubscription(subscription);
  let device = subscription.devices.find((entry) => entry.deviceId === deviceId);
  if (!device) {
    device = { deviceId, status: 'pending' };
    subscription.devices.push(device);
  }
  Object.assign(device, patch);
  subscription.updatedAt = Date.now();
  persistNow();
  return cloneTestFlightSubscription(subscription);
}

export function updateTestFlightSubscriptionMetadata(
  id: string,
  patch: Pick<TestFlightSubscription, 'appId' | 'bundleId' | 'displayName' | 'iconUrl' | 'sellerName' | 'category'>,
): TestFlightSubscription | undefined {
  const subscription = state.testFlightSubscriptions.find((entry) => entry.id === id);
  if (!subscription) return undefined;
  if (subscription.bundleId === IMMUTABLE_TESTFLIGHT_BUNDLE_ID) return cloneTestFlightSubscription(subscription);
  Object.assign(subscription, patch, { updatedAt: Date.now() });
  persistNow();
  return cloneTestFlightSubscription(subscription);
}

export function recordTestFlightSubscriptionSync(id: string, actor: string, detail: string): void {
  recordAudit(actor, 'testflight-subscription.sync', id, detail);
}

export interface CreateDeviceInput {
  name: string;
  transport?: 'wifi' | 'usb';
  host?: string;
  port?: number;
  user?: string;
  udid?: string;
  usbmuxNetwork?: boolean;
  productType?: string;
  iosVersion?: string;
  toolchain?: string;
  notes?: string;
  enabled?: boolean;
  isPrimary?: boolean;
}

function clearOtherPrimaries(exceptId?: string): void {
  for (const d of state.devices) if (d.id !== exceptId) d.isPrimary = false;
}

export function createDevice(input: CreateDeviceInput, actor: string): DeviceRecord {
  const now = Date.now();
  const makePrimary = input.isPrimary || !state.devices.some((d) => d.isPrimary);
  const transport = input.transport ?? (input.udid ? input.usbmuxNetwork ? 'wifi' : 'usb' : 'wifi');
  const device: DeviceRecord = {
    id: randomUUID(),
    name: input.name,
    transport,
    host: input.host?.trim() || undefined,
    port: input.port,
    user: input.user?.trim() || undefined,
    udid: input.udid?.trim() || undefined,
    usbmuxNetwork: input.usbmuxNetwork,
    productType: input.productType?.trim() || undefined,
    iosVersion: input.iosVersion?.trim() || undefined,
    toolchain: input.toolchain?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
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
  const device = state.devices.find((d) => d.id === id);
  if (!device) return { ok: false, error: 'device not found' };
  Object.assign(device, patch, { updatedAt: Date.now() });
  if (patch.isPrimary) clearOtherPrimaries(device.id);

  if (!state.devices.some((d) => d.enabled && d.isPrimary)) {
    const fallback = state.devices.find((d) => d.enabled);
    if (fallback) fallback.isPrimary = true;
  }
  persistNow();
  recordAudit(actor, 'device.update', device.id, device.name);
  return { ok: true, device };
}

export function deleteDevice(id: string, actor: string): boolean {
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
  filters?: {
    bundleIdSearch?: string;
    source?: 'manual' | 'scheduler';
    status?: 'done' | 'failed';
    queuedBy?: string;
    deviceId?: string;
    errorSearch?: string;
    failureCategory?: string;
    fromTs?: number;
    toTs?: number;
  },
): { entries: JobHistoryEntry[]; total: number } {
  const bundleIdSearch = filters?.bundleIdSearch?.toLowerCase();
  const source = filters?.source;
  const status = filters?.status;
  const queuedBy = filters?.queuedBy?.toLowerCase();
  const deviceId = filters?.deviceId;
  const errorSearch = filters?.errorSearch?.toLowerCase();
  const failureCategory = filters?.failureCategory;
  const fromTs = filters?.fromTs;
  const toTs = filters?.toTs;

  const filtered = state.jobHistory.filter(
    (e) =>
      (!bundleIdSearch || e.bundleId.toLowerCase().includes(bundleIdSearch)) &&
      (!source || e.source === source) &&
      (!status || e.status === status) &&
      (!queuedBy || (e.queuedBy ?? '').toLowerCase().includes(queuedBy)) &&
      (!deviceId || (e.deviceId ?? '') === deviceId) &&
      (!errorSearch || (e.error ?? '').toLowerCase().includes(errorSearch)) &&
      (!failureCategory || (e.status === 'failed' && categorizeFailure(e.error) === failureCategory)) &&
      (!fromTs || e.finishedAt >= fromTs) &&
      (!toTs || e.finishedAt <= toTs),
  );
  return { entries: filtered.slice(offset, offset + limit), total: filtered.length };
}

export function getAllJobHistory(): JobHistoryEntry[] {
  return state.jobHistory;
}

export function getUserJobHistory(username: string): JobHistoryEntry[] {
  const lower = username.toLowerCase();
  return state.jobHistory.filter((entry) => entry.queuedBy?.toLowerCase() === lower).map((entry) => structuredClone(entry));
}

export function previewJobHistoryRetention(retentionDays: number, now = Date.now()): {
  retentionDays: number;
  cutoff?: number;
  retained: number;
  removed: number;
} {
  const normalizedDays = Math.max(0, Math.round(retentionDays));
  if (normalizedDays === 0) return { retentionDays: normalizedDays, retained: state.jobHistory.length, removed: 0 };
  const cutoff = now - normalizedDays * 86_400_000;
  const retained = state.jobHistory.filter((entry) => entry.finishedAt >= cutoff).length;
  return { retentionDays: normalizedDays, cutoff, retained, removed: state.jobHistory.length - retained };
}

export interface UserActivityStats {
  manualJobs: number;
  completedJobs: number;
  failedJobs: number;
  lastJobAt?: number;
  apiKeys: number;
  apiRequests30d: number;
}

export function getUserActivityStats(): Map<string, UserActivityStats> {
  const stats = new Map<string, UserActivityStats>();
  const ensure = (username: string): UserActivityStats => {
    const key = username.toLowerCase();
    const current = stats.get(key);
    if (current) return current;
    const next = { manualJobs: 0, completedJobs: 0, failedJobs: 0, apiKeys: 0, apiRequests30d: 0 };
    stats.set(key, next);
    return next;
  };
  for (const job of state.jobHistory) {
    if (!job.queuedBy || job.source !== 'manual') continue;
    const activity = ensure(job.queuedBy);
    activity.manualJobs += 1;
    if (job.status === 'done') activity.completedJobs += 1;
    else activity.failedJobs += 1;
    activity.lastJobAt = Math.max(activity.lastJobAt ?? 0, job.finishedAt) || undefined;
  }
  for (const key of state.apiKeys) {
    const activity = ensure(key.ownerId);
    activity.apiKeys += 1;
    activity.apiRequests30d += getApiKeyUsage(key.id, 30).reduce((total, bucket) => total + bucket.count, 0);
  }
  return stats;
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
  anomalies: PerformanceAnomaly[];
}

export interface PerformanceAnomaly {
  jobId: string;
  bundleId: string;
  versionLabel?: string;
  finishedAt: number;
  kind: 'duration' | 'size' | 'duration-and-size';
  durationMs?: number;
  baselineDurationMs?: number;
  durationRatio?: number;
  sizeBytes?: number;
  baselineSizeBytes?: number;
  sizeRatio?: number;
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

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function getPerformanceAnomalies(runs: JobHistoryEntry[]): PerformanceAnomaly[] {
  const byBundle = new Map<string, JobHistoryEntry[]>();
  for (const run of runs.filter((entry) => entry.status === 'done')) {
    const bundleRuns = byBundle.get(run.bundleId) ?? [];
    bundleRuns.push(run);
    byBundle.set(run.bundleId, bundleRuns);
  }

  const anomalies: PerformanceAnomaly[] = [];
  for (const bundleRuns of byBundle.values()) {
    const ordered = [...bundleRuns].sort((a, b) => a.finishedAt - b.finishedAt);
    for (let index = 0; index < ordered.length; index += 1) {
      const current = ordered[index];
      const allPrevious = ordered.slice(0, index);
      const sameDevicePrevious = current.deviceId ? allPrevious.filter((entry) => entry.deviceId === current.deviceId) : [];
      const previous = sameDevicePrevious.length >= 3 ? sameDevicePrevious : allPrevious;
      if (previous.length < 3) continue;
      const durationMs = current.startedAt ? current.finishedAt - current.startedAt : undefined;
      const baselineDurationMs = median(previous.filter((entry) => entry.startedAt).map((entry) => entry.finishedAt - (entry.startedAt as number)));
      const baselineSizeBytes = median(previous.map((entry) => entry.sizeBytes).filter((size): size is number => typeof size === 'number' && size > 0));
      const durationRatio = durationMs && baselineDurationMs ? durationMs / baselineDurationMs : undefined;
      const sizeRatio = current.sizeBytes && baselineSizeBytes ? current.sizeBytes / baselineSizeBytes : undefined;
      const durationAnomaly = durationMs !== undefined && baselineDurationMs !== undefined && durationRatio !== undefined && durationRatio >= 1.75 && durationMs - baselineDurationMs >= 60_000;
      const sizeAnomaly = current.sizeBytes !== undefined && baselineSizeBytes !== undefined && sizeRatio !== undefined && sizeRatio >= 1.5 && current.sizeBytes - baselineSizeBytes >= 5 * 1024 * 1024;
      if (!durationAnomaly && !sizeAnomaly) continue;
      anomalies.push({
        jobId: current.id,
        bundleId: current.bundleId,
        versionLabel: current.versionLabel,
        finishedAt: current.finishedAt,
        kind: durationAnomaly && sizeAnomaly ? 'duration-and-size' : durationAnomaly ? 'duration' : 'size',
        durationMs,
        baselineDurationMs,
        durationRatio,
        sizeBytes: current.sizeBytes,
        baselineSizeBytes,
        sizeRatio,
      });
    }
  }
  return anomalies.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, 20);
}

export function getInsightsSummary(topAppsLimit = 5, trendDays = 14): InsightsSummary {
  const runs = state.jobHistory;
  const doneCount = runs.filter((j) => j.status === 'done').length;
  const failedCount = runs.filter((j) => j.status === 'failed').length;
  const totalSizeBytes = runs.reduce((sum, j) => sum + (j.sizeBytes ?? 0), 0);

  const byBundle = new Map<string, InsightsAppStats>();
  const durationsByBundle = new Map<string, number[]>();
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

    if (j.status === 'done' && j.startedAt) {
      const durations = durationsByBundle.get(j.bundleId) ?? [];
      durations.push(j.finishedAt - j.startedAt);
      durationsByBundle.set(j.bundleId, durations);
    }
  }
  const topApps = [...byBundle.values()]
    .map((a) => {
      const durations = durationsByBundle.get(a.bundleId);
      const avgDurationMs = durations && durations.length > 0 ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length) : undefined;
      return { ...a, successRate: a.totalRuns > 0 ? a.doneCount / a.totalRuns : 0, avgDurationMs };
    })
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
    byDevice: getDeviceThroughput(),
    anomalies: getPerformanceAnomalies(runs),
  };
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

export function getDeviceThroughput(): DeviceThroughputStats[] {
  const devicesById = new Map(getEffectiveDevices().map((d) => [d.id, d]));
  const byDevice = new Map<string, JobHistoryEntry[]>();
  for (const j of state.jobHistory) {
    if (!j.deviceId) continue;
    const list = byDevice.get(j.deviceId) ?? [];
    list.push(j);
    byDevice.set(j.deviceId, list);
  }

  return [...byDevice.entries()]
    .map(([deviceId, runs]) => {
      const doneCount = runs.filter((j) => j.status === 'done').length;
      const failedCount = runs.filter((j) => j.status === 'failed').length;
      const durations = runs.filter((j) => j.status === 'done' && j.startedAt).map((j) => j.finishedAt - (j.startedAt as number));
      return {
        deviceId,
        deviceName: devicesById.get(deviceId)?.name ?? deviceId,
        removed: !devicesById.has(deviceId),
        totalRuns: runs.length,
        doneCount,
        failedCount,
        successRate: runs.length > 0 ? doneCount / runs.length : 0,
        totalSizeBytes: runs.reduce((sum, j) => sum + (j.sizeBytes ?? 0), 0),
        avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : undefined,
      };
    })
    .sort((a, b) => b.totalRuns - a.totalRuns);
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

export function updateSchedulerRunOutcome(entryId: string, source: 'appStore' | 'testflight', patch: Partial<SchedulerRunOutcome>): void {
  const entry = state.schedulerRunHistory.find((e) => e.id === entryId);
  if (!entry) return;
  entry[source] = { ...entry[source], ...patch };
  persistNow();
}

export function getSchedulerRunHistory(limit = 10, watchId?: string): SchedulerRunEntry[] {
  const legacyWatch = getEffectiveWatches()[0];
  const filled = state.schedulerRunHistory.map((e) =>
    e.watchId ? e : { ...e, watchId: legacyWatch?.id, bundleId: legacyWatch?.bundleId },
  );
  const filtered = watchId ? filled.filter((e) => e.watchId === watchId) : filled;
  return filtered.slice(0, limit);
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

export function getWatchHealthRollup(): WatchHealthSummary[] {
  return getEffectiveWatches().map((watch) => {
    const entries = getSchedulerRunHistory(MAX_SCHEDULER_RUNS, watch.id);
    let consecutiveFailures = 0;
    for (const e of entries) {
      if (e.appStore.ok && e.testflight.ok) break;
      consecutiveFailures += 1;
    }
    const last = entries[0];
    const schedulerJobs = state.jobHistory.filter((job) => job.source === 'scheduler' && job.bundleId === watch.bundleId);
    const completedJobs = schedulerJobs.filter((job) => job.status === 'done');
    const durations = completedJobs
      .filter((job) => job.startedAt)
      .map((job) => job.finishedAt - (job.startedAt as number))
      .sort((a, b) => a - b);
    const midpoint = Math.floor(durations.length / 2);
    const medianSchedulerJobDurationMs = durations.length === 0
      ? undefined
      : durations.length % 2 === 1
        ? durations[midpoint]
        : Math.round((durations[midpoint - 1] + durations[midpoint]) / 2);
    return {
      watchId: watch.id,
      bundleId: watch.bundleId,
      schedulable: isWatchSchedulable(watch),
      dispatchTargetCount: getWatchDispatchTargets(watch).length,
      lastCheckAt: last?.ts,
      lastCheckOk: last ? last.appStore.ok && last.testflight.ok : undefined,
      consecutiveFailures,
      everTriggeredInHistory: entries.some((e) => e.appStore.triggered || e.testflight.triggered),
      historyCount: entries.length,
      schedulerJobCount: schedulerJobs.length,
      schedulerJobSuccessRate: schedulerJobs.length > 0 ? completedJobs.length / schedulerJobs.length : undefined,
      medianSchedulerJobDurationMs,
    };
  });
}

export function recordDeviceActivity(entry: Omit<DeviceActivityEntry, 'id' | 'ts'>): void {
  state.deviceActivity.unshift({ id: randomUUID(), ts: Date.now(), ...entry });
  if (state.deviceActivity.length > MAX_DEVICE_ACTIVITY) state.deviceActivity.length = MAX_DEVICE_ACTIVITY;
  persistNow();
}

export function getDeviceActivity(deviceId: string, limit = 20): DeviceActivityEntry[] {
  return state.deviceActivity.filter((entry) => entry.deviceId === deviceId).slice(0, limit);
}

export function getDeviceActivityPage(deviceId: string, offset = 0, limit = 20): { entries: DeviceActivityEntry[]; total: number } {
  const owned = state.deviceActivity.filter((entry) => entry.deviceId === deviceId);
  const normalizedOffset = Math.max(offset, 0);
  return { entries: owned.slice(normalizedOffset, normalizedOffset + Math.max(limit, 1)), total: owned.length };
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

export function getConsecutiveDeviceHealthFailures(deviceId: string): number {
  const history = [...historyFor(deviceId)].reverse();
  let failures = 0;
  for (const check of history) {
    if (check.reachable) break;
    failures += 1;
  }
  return failures;
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

export function getUsersWithPushSubscriptions(): string[] {
  return Object.keys(state.pushSubscriptions).filter((username) => state.pushSubscriptions[username].length > 0);
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

export function recordNotification(input: Omit<NotificationRecord, 'id' | 'createdAt' | 'readAt'>): NotificationRecord {
  const notification: NotificationRecord = { ...input, id: randomUUID(), createdAt: Date.now() };
  state.notifications.unshift(notification);
  if (state.notifications.length > MAX_NOTIFICATIONS) state.notifications.length = MAX_NOTIFICATIONS;
  persistNow();
  return notification;
}

export function listNotifications(userId: string, limit = 50): { notifications: NotificationRecord[]; unread: number } {
  const page = listNotificationsPage(userId, 0, limit);
  return { notifications: page.notifications, unread: page.unread };
}

export function listNotificationsPage(userId: string, offset = 0, limit = 50): { notifications: NotificationRecord[]; unread: number; total: number } {
  const lower = userId.toLowerCase();
  const owned = state.notifications.filter((notification) => notification.userId.toLowerCase() === lower);
  return {
    notifications: owned.slice(Math.max(offset, 0), Math.max(offset, 0) + Math.min(Math.max(limit, 1), 100)).map((notification) => ({ ...notification })),
    unread: owned.filter((notification) => !notification.readAt).length,
    total: owned.length,
  };
}

export function markNotificationsRead(userId: string, ids?: string[]): number {
  const lower = userId.toLowerCase();
  const allowed = ids ? new Set(ids) : undefined;
  const now = Date.now();
  let changed = 0;
  for (const notification of state.notifications) {
    if (notification.userId.toLowerCase() !== lower || notification.readAt || (allowed && !allowed.has(notification.id))) continue;
    notification.readAt = now;
    changed += 1;
  }
  if (changed > 0) persistNow();
  return changed;
}

const BACKUP_VERSION = 6;

export interface BackupPayload {
  backupVersion: typeof BACKUP_VERSION;
  exportedAt: number;
  allowedUsers: AllowedUser[];
  roles: Role[];
  apiKeys: ApiKeyRecord[];
  settings: Partial<SchedulerSettings>;
  watches: AppWatch[];
  devices: DeviceRecord[];
  jobHistory: JobHistoryEntry[];
  lastSchedulerRunAt?: number;
  userPrefs: Record<string, UserPrefs>;
  auditLog: AuditLogEntry[];
  schedulerRunHistory: SchedulerRunEntry[];
  rootSessionVersion: number;
  apiKeyUsage: Record<string, ApiKeyUsageBucket[]>;
  apiKeyBundleUsage: Record<string, Record<string, number>>;
  deviceActivity: DeviceActivityEntry[];
  testFlightSubscriptions: TestFlightSubscription[];
  rootMfa?: UserMfaRecord;
  passkeys: PasskeyCredential[];
  billing: BillingSnapshot;
  identities: IdentitySnapshot;
}

export function exportBackup(): BackupPayload {
  return {
    backupVersion: BACKUP_VERSION,
    exportedAt: Date.now(),
    allowedUsers: state.allowedUsers,
    roles: state.roles,
    apiKeys: state.apiKeys.map((k) => ({ ...k, pendingReveal: undefined })),
    settings: state.settings,
    watches: getEffectiveWatches(),
    devices: getEffectiveDevices(),
    jobHistory: state.jobHistory,
    lastSchedulerRunAt: state.lastSchedulerRunAt,
    userPrefs: state.userPrefs,
    auditLog: state.auditLog,
    schedulerRunHistory: state.schedulerRunHistory,
    rootSessionVersion: state.rootSessionVersion,
    apiKeyUsage: state.apiKeyUsage,
    apiKeyBundleUsage: state.apiKeyBundleUsage,
    deviceActivity: state.deviceActivity,
    testFlightSubscriptions: getTestFlightSubscriptions(),
    rootMfa: state.rootMfa,
    passkeys: state.passkeys.map((credential) => ({ ...credential, transports: credential.transports ? [...credential.transports] : undefined })),
    billing: exportBillingSnapshot(),
    identities: exportIdentitySnapshot(),
  };
}

export function getBackupSchedule(): BackupScheduleSettings {
  return { ...state.backupSchedule };
}

export function setBackupSchedule(patch: Partial<BackupScheduleSettings>, actor: string): BackupScheduleSettings {
  state.backupSchedule = { ...state.backupSchedule, ...patch };
  persistNow();
  recordAudit(actor, 'backup.schedule-update', 'backup-schedule', JSON.stringify(patch));
  return { ...state.backupSchedule };
}

export function getBackupHistory(): BackupHistoryEntry[] {
  return [...state.backupHistory].sort((a, b) => b.createdAt - a.createdAt);
}

export function createBackupSnapshot(trigger: 'scheduled' | 'manual'): BackupHistoryEntry {
  mkdirSync(backupsDir, { recursive: true });
  const payload = exportBackup();
  const json = JSON.stringify(payload, null, 2);
  const id = randomUUID();
  const filename = `backup-${payload.exportedAt}-${id.slice(0, 8)}.json`;
  const databaseFilename = `${filename}.sqlite`;
  const manifestFilename = `${filename}.manifest`;
  const jsonPath = path.join(backupsDir, filename);
  const databasePath = path.join(backupsDir, databaseFilename);
  const manifestPath = path.join(backupsDir, manifestFilename);
  const temporaryJsonPath = `${jsonPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryJsonPath, `${json}\n`, { mode: 0o600 });
    const descriptor = openSync(temporaryJsonPath, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryJsonPath, jsonPath);
    stateDatabase.backupTo(databasePath);
    verifyDatabaseBackup(databasePath);
    const manifest = encryptedBackupManifest({
      backupVersion: payload.backupVersion,
      exportedAt: payload.exportedAt,
      stateSchemaVersion: stateDatabase.schemaVersion,
      jsonSha256: createHash('sha256').update(readFileSync(jsonPath)).digest('hex'),
      databaseSha256: createHash('sha256').update(readFileSync(databasePath)).digest('hex'),
    });
    writeFileSync(manifestPath, `${manifest}\n`, { mode: 0o600 });
    verifyEncryptedBackupManifest(manifestPath, jsonPath, databasePath);
  } catch (error) {
    for (const filePath of [temporaryJsonPath, jsonPath, databasePath, manifestPath]) rmSync(filePath, { force: true });
    throw error;
  }

  const entry: BackupHistoryEntry = {
    id,
    createdAt: payload.exportedAt,
    sizeBytes: Buffer.byteLength(json) + readFileSync(databasePath).byteLength,
    filename,
    databaseFilename,
    manifestFilename,
    schemaVersion: stateDatabase.schemaVersion,
    integrity: 'verified',
    encryptedManifest: true,
    trigger,
  };
  state.backupHistory = [entry, ...state.backupHistory];
  const retention = Math.max(1, state.backupSchedule.retentionCount);
  while (state.backupHistory.length > retention) {
    const removed = state.backupHistory.pop();
    if (!removed) break;
    const filePath = path.join(backupsDir, removed.filename);
    if (existsSync(filePath)) rmSync(filePath);
    if (removed.databaseFilename) {
      const databasePath = path.join(backupsDir, removed.databaseFilename);
      if (existsSync(databasePath)) rmSync(databasePath);
    }
    if (removed.manifestFilename) {
      const manifestPath = path.join(backupsDir, removed.manifestFilename);
      if (existsSync(manifestPath)) rmSync(manifestPath);
    }
  }
  persistNow();
  return entry;
}

export function getBackupSnapshotPath(id: string): string | undefined {
  const entry = state.backupHistory.find((e) => e.id === id);
  if (!entry) return undefined;
  const filePath = path.join(backupsDir, entry.filename);
  return existsSync(filePath) ? filePath : undefined;
}

export function verifyLatestDatabaseBackup(): { ok: boolean; detail: string } {
  const entry = getBackupHistory().find((candidate) => candidate.databaseFilename);
  if (!entry?.databaseFilename || !entry.manifestFilename) return { ok: false, detail: 'No verified SQLite backup has been created yet' };
  const databasePath = path.join(backupsDir, entry.databaseFilename);
  try {
    const result = verifyDatabaseBackup(databasePath);
    verifyEncryptedBackupManifest(path.join(backupsDir, entry.manifestFilename), path.join(backupsDir, entry.filename), databasePath);
    return { ok: result.hasStateSnapshot, detail: result.hasStateSnapshot ? `SQLite schema ${result.schemaVersion} restored and verified` : 'SQLite backup has no state snapshot' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function deleteBackupSnapshot(id: string, actor: string): boolean {
  const idx = state.backupHistory.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const [removed] = state.backupHistory.splice(idx, 1);
  const filePath = path.join(backupsDir, removed.filename);
  if (existsSync(filePath)) rmSync(filePath);
  if (removed.databaseFilename) {
    const databasePath = path.join(backupsDir, removed.databaseFilename);
    if (existsSync(databasePath)) rmSync(databasePath);
  }
  if (removed.manifestFilename) {
    const manifestPath = path.join(backupsDir, removed.manifestFilename);
    if (existsSync(manifestPath)) rmSync(manifestPath);
  }
  persistNow();
  recordAudit(actor, 'backup.delete', removed.filename, '');
  return true;
}

function isAllowedUserShape(value: unknown): value is AllowedUser {
  if (typeof value !== 'object' || value === null) return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.username === 'string' &&
    typeof u.addedAt === 'number' &&
    Array.isArray(u.roleIds) &&
    u.roleIds.every((id) => typeof id === 'string') &&
    (u.mfa === undefined || isUserMfaShape(u.mfa))
  );
}

function isPasskeyCredentialShape(value: unknown): value is PasskeyCredential {
  if (typeof value !== 'object' || value === null) return false;
  const credential = value as Record<string, unknown>;
  return (
    typeof credential.id === 'string' &&
    typeof credential.userId === 'string' &&
    typeof credential.publicKey === 'string' &&
    typeof credential.counter === 'number' &&
    Number.isInteger(credential.counter) &&
    credential.counter >= 0 &&
    (credential.transports === undefined || (Array.isArray(credential.transports) && credential.transports.every((transport) => typeof transport === 'string'))) &&
    (credential.name === undefined || typeof credential.name === 'string') &&
    typeof credential.createdAt === 'number' &&
    (credential.lastUsedAt === undefined || typeof credential.lastUsedAt === 'number')
  );
}

function isUserMfaShape(value: unknown): value is UserMfaRecord {
  if (typeof value !== 'object' || value === null) return false;
  const mfa = value as Record<string, unknown>;
  return (
    typeof mfa.enabled === 'boolean' &&
    (mfa.secretCiphertext === undefined || typeof mfa.secretCiphertext === 'string') &&
    (mfa.pendingSecretCiphertext === undefined || typeof mfa.pendingSecretCiphertext === 'string') &&
    (mfa.recoveryCodeHashes === undefined || (Array.isArray(mfa.recoveryCodeHashes) && mfa.recoveryCodeHashes.every((hash) => typeof hash === 'string'))) &&
    (mfa.updatedAt === undefined || typeof mfa.updatedAt === 'number')
  );
}

function isRoleShape(value: unknown): value is Role {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.color === 'string' &&
    typeof r.permissions === 'string' &&
    typeof r.position === 'number' &&
    typeof r.isDefault === 'boolean'
  );
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
  const hasDirectConnection = (d.transport === 'wifi' || d.transport === 'usb') && (typeof d.host === 'string' || typeof d.udid === 'string');
  return typeof d.id === 'string' && typeof d.name === 'string' && typeof d.enabled === 'boolean' && hasDirectConnection;
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

function isTestFlightSubscriptionDeviceShape(value: unknown): value is TestFlightSubscriptionDevice {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.deviceId === 'string' && ['pending', 'syncing', 'active', 'unavailable', 'unsupported', 'error', 'unsubscribed'].includes(String(d.status));
}

function isTestFlightSubscriptionShape(value: unknown): value is TestFlightSubscription {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.id === 'string' &&
    typeof s.url === 'string' &&
    typeof s.inviteCode === 'string' &&
    typeof s.requestedBy === 'string' &&
    ['pending', 'approved', 'denied', 'withdrawn'].includes(String(s.status)) &&
    typeof s.createdAt === 'number' &&
    typeof s.updatedAt === 'number' &&
    Array.isArray(s.devices) &&
    s.devices.every(isTestFlightSubscriptionDeviceShape) &&
    s.devicePolicy === 'all-enabled'
  );
}

function isTestFlightCatalogCacheAppShape(value: unknown): value is TestFlightCatalogCacheApp {
  if (typeof value !== 'object' || value === null) return false;
  const app = value as Record<string, unknown>;
  return (
    typeof app.appId === 'number' &&
    typeof app.bundleId === 'string' &&
    typeof app.displayName === 'string' &&
    typeof app.lastVerifiedAt === 'number' &&
    app.deviceSource === true &&
    Array.isArray(app.devices) &&
    app.devices.every((device) => typeof device === 'object' && device !== null && typeof (device as Record<string, unknown>).id === 'string' && typeof (device as Record<string, unknown>).name === 'string')
  );
}

function isTestFlightCatalogCacheShape(value: unknown): value is TestFlightCatalogCache {
  if (typeof value !== 'object' || value === null) return false;
  const cache = value as Record<string, unknown>;
  return (
    typeof cache.fetchedAt === 'number' &&
    Array.isArray(cache.deviceIds) &&
    cache.deviceIds.every((deviceId) => typeof deviceId === 'string') &&
    Array.isArray(cache.apps) &&
    cache.apps.every(isTestFlightCatalogCacheAppShape) &&
    (cache.complete === undefined || typeof cache.complete === 'boolean')
  );
}

interface ValidatedBackupPayload {
  backupVersion: number;
  exportedAt?: number;
  allowedUsers: AllowedUser[];
  roles: Role[];
  apiKeys: ApiKeyRecord[];
  settings: Partial<SchedulerSettings>;
  watches: AppWatch[];
  devices: DeviceRecord[];
  jobHistory: JobHistoryEntry[];
  lastSchedulerRunAt?: number;
  userPrefs: Record<string, UserPrefs>;
  auditLog: AuditLogEntry[];
  schedulerRunHistory: SchedulerRunEntry[];
  rootSessionVersion: number;
  apiKeyUsage: Record<string, ApiKeyUsageBucket[]>;
  apiKeyBundleUsage?: Record<string, Record<string, number>>;
  deviceActivity?: DeviceActivityEntry[];
  testFlightSubscriptions: TestFlightSubscription[];
  rootMfa?: UserMfaRecord;
  passkeys: PasskeyCredential[];
  billing: BillingSnapshot;
  identities: IdentitySnapshot;
}

function validateBackupPayload(raw: unknown): { ok: true; payload: ValidatedBackupPayload } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'not a valid backup file' };
  const b = raw as Record<string, unknown>;

  if (b.backupVersion !== 3 && b.backupVersion !== 4 && b.backupVersion !== 5 && b.backupVersion !== BACKUP_VERSION) {
    return { ok: false, error: `unsupported backup version (expected 3, 4, 5, or ${BACKUP_VERSION})` };
  }
  if (!Array.isArray(b.allowedUsers) || !b.allowedUsers.every(isAllowedUserShape)) {
    return { ok: false, error: 'allowedUsers is missing or malformed' };
  }
  if (!Array.isArray(b.roles) || !b.roles.every(isRoleShape) || !b.roles.some((r) => (r as Role).isDefault)) {
    return { ok: false, error: 'roles is missing or malformed' };
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
  if (typeof b.rootSessionVersion !== 'number') {
    return { ok: false, error: 'rootSessionVersion is missing or malformed' };
  }
  if (b.rootMfa !== undefined && !isUserMfaShape(b.rootMfa)) {
    return { ok: false, error: 'rootMfa is malformed' };
  }
  if (b.passkeys !== undefined && (!Array.isArray(b.passkeys) || !b.passkeys.every(isPasskeyCredentialShape))) {
    return { ok: false, error: 'passkeys is malformed' };
  }
  if (b.backupVersion === BACKUP_VERSION && (!Array.isArray(b.testFlightSubscriptions) || !b.testFlightSubscriptions.every(isTestFlightSubscriptionShape))) {
    return { ok: false, error: 'testFlightSubscriptions is missing or malformed' };
  }
  if (b.backupVersion >= 4 && !isBillingSnapshot(b.billing)) {
    return { ok: false, error: 'billing is missing or malformed' };
  }
  if (b.backupVersion >= 4 && !isIdentitySnapshot(b.identities)) {
    return { ok: false, error: 'identities is missing or malformed' };
  }

  return {
    ok: true,
    payload: {
      backupVersion: b.backupVersion as number,
      exportedAt: typeof b.exportedAt === 'number' ? b.exportedAt : undefined,
      allowedUsers: b.allowedUsers as AllowedUser[],
      roles: b.roles as Role[],
      apiKeys: b.apiKeys as ApiKeyRecord[],
      settings: b.settings as Partial<SchedulerSettings>,
      watches: b.watches as AppWatch[],
      devices: b.devices as DeviceRecord[],
      jobHistory: b.jobHistory as JobHistoryEntry[],
      lastSchedulerRunAt: typeof b.lastSchedulerRunAt === 'number' ? b.lastSchedulerRunAt : undefined,
      userPrefs: b.userPrefs as Record<string, UserPrefs>,
      auditLog: b.auditLog as AuditLogEntry[],
      schedulerRunHistory: b.schedulerRunHistory as SchedulerRunEntry[],
      rootSessionVersion: b.rootSessionVersion as number,
      apiKeyUsage: b.apiKeyUsage as Record<string, ApiKeyUsageBucket[]>,
      apiKeyBundleUsage:
        typeof b.apiKeyBundleUsage === 'object' && b.apiKeyBundleUsage !== null
          ? (b.apiKeyBundleUsage as Record<string, Record<string, number>>)
          : undefined,
      deviceActivity: Array.isArray(b.deviceActivity) ? (b.deviceActivity as DeviceActivityEntry[]) : undefined,
      testFlightSubscriptions: Array.isArray(b.testFlightSubscriptions) ? (b.testFlightSubscriptions as TestFlightSubscription[]) : [],
      rootMfa: b.rootMfa as UserMfaRecord | undefined,
      passkeys: Array.isArray(b.passkeys) ? (b.passkeys as PasskeyCredential[]) : [],
      billing: isBillingSnapshot(b.billing)
        ? b.billing
        : { customers: [], subscriptions: [], cryptoCheckouts: [], cryptoCharges: [], processedEvents: [] },
      identities: isIdentitySnapshot(b.identities) ? b.identities : { profiles: [] },
    },
  };
}

export interface BackupPreviewSummary {
  exportedAt?: number;
  incoming: {
    users: number;
    roles: number;
    apiKeys: number;
    watches: number;
    devices: number;
    jobHistory: number;
    auditLog: number;
  };
  current: {
    users: number;
    roles: number;
    apiKeys: number;
    watches: number;
    devices: number;
    jobHistory: number;
    auditLog: number;
  };
}

export function previewBackup(raw: unknown): { ok: true; summary: BackupPreviewSummary } | { ok: false; error: string } {
  const validated = validateBackupPayload(raw);
  if (!validated.ok) return validated;
  const { payload } = validated;
  return {
    ok: true,
    summary: {
      exportedAt: payload.exportedAt,
      incoming: {
        users: payload.allowedUsers.length,
        roles: payload.roles.length,
        apiKeys: payload.apiKeys.length,
        watches: payload.watches.length,
        devices: payload.devices.length,
        jobHistory: payload.jobHistory.length,
        auditLog: payload.auditLog.length,
      },
      current: {
        users: state.allowedUsers.length,
        roles: state.roles.length,
        apiKeys: state.apiKeys.length,
        watches: state.watches.length,
        devices: state.devices.length,
        jobHistory: state.jobHistory.length,
        auditLog: state.auditLog.length,
      },
    },
  };
}

export interface BackupRestoreDrill {
  ok: boolean;
  checks: { label: string; ok: boolean; detail: string }[];
}

function prepareBackupRestore(payload: ValidatedBackupPayload): Pick<PersistedState, 'allowedUsers' | 'roles' | 'apiKeys' | 'settings' | 'watches' | 'devices' | 'jobHistory' | 'auditLog' | 'schedulerRunHistory' | 'userPrefs' | 'apiKeyUsage' | 'rootSessionVersion' | 'apiKeyBundleUsage' | 'deviceActivity' | 'testFlightSubscriptions' | 'rootMfa' | 'passkeys'> {
  return {
    allowedUsers: payload.allowedUsers,
    roles: payload.roles.map((role) => ({ ...role, permissions: serializeBits(consolidatePermissionBits(upgradePermissionBits(parseBits(role.permissions)))) })),
    apiKeys: payload.apiKeys.map((key) => ({ ...key, pendingReveal: undefined })),
    settings: payload.settings,
    watches: payload.watches,
    devices: payload.devices.map(normalizeLoadedDevice),
    jobHistory: payload.jobHistory.slice(0, MAX_HISTORY),
    auditLog: payload.auditLog.slice(0, MAX_AUDIT_LOG),
    schedulerRunHistory: payload.schedulerRunHistory.slice(0, MAX_SCHEDULER_RUNS).map((entry) => ({ ...entry, id: entry.id ?? randomUUID() })),
    userPrefs: payload.userPrefs,
    apiKeyUsage: payload.apiKeyUsage,
    rootSessionVersion: payload.rootSessionVersion,
    apiKeyBundleUsage: payload.apiKeyBundleUsage ?? {},
    deviceActivity: payload.deviceActivity?.slice(0, MAX_DEVICE_ACTIVITY) ?? [],
    testFlightSubscriptions: payload.testFlightSubscriptions.map(cloneTestFlightSubscription),
    rootMfa: payload.rootMfa,
    passkeys: payload.passkeys.map((credential) => ({ ...credential, transports: credential.transports ? [...credential.transports] : undefined })),
  };
}

export function drillBackupRestore(raw: unknown): { ok: true; drill: BackupRestoreDrill } | { ok: false; error: string } {
  const validated = validateBackupPayload(raw);
  if (!validated.ok) return validated;
  const { payload } = validated;
  const restored = prepareBackupRestore(payload);
  const roleIds = new Set(payload.roles.map((role) => role.id));
  const userIds = new Set(payload.allowedUsers.map((user) => user.username.toLowerCase()));
  const watchIds = new Set(payload.watches.map((watch) => watch.id));
  const deviceIds = new Set(payload.devices.map((device) => device.id));
  const checks = [
    { label: 'Unique role IDs', ok: roleIds.size === payload.roles.length, detail: `${roleIds.size} roles` },
    { label: 'Default role', ok: payload.roles.filter((role) => role.isDefault).length === 1, detail: `${payload.roles.filter((role) => role.isDefault).length} default roles` },
    { label: 'User role assignments', ok: payload.allowedUsers.every((user) => user.roleIds.every((id) => roleIds.has(id))), detail: `${payload.allowedUsers.length} users checked` },
    { label: 'API key owners', ok: payload.apiKeys.every((key) => key.ownerId === 'root' || userIds.has(key.ownerId.toLowerCase())), detail: `${payload.apiKeys.length} keys checked` },
    { label: 'Unique watch IDs', ok: watchIds.size === payload.watches.length, detail: `${watchIds.size} watches` },
    { label: 'Unique device IDs', ok: deviceIds.size === payload.devices.length, detail: `${deviceIds.size} devices` },
    { label: 'Restore transformation', ok: restored.roles.length === payload.roles.length && restored.apiKeys.every((key) => key.pendingReveal === undefined), detail: `${restored.apiKeys.length} keys normalized` },
    { label: 'Serializable restored state', ok: (() => { try { JSON.stringify(restored); return true; } catch { return false; } })(), detail: 'normalized state checked' },
  ];
  return { ok: true, drill: { ok: checks.every((check) => check.ok), checks } };
}

export interface ImportBackupResult {
  ok: boolean;
  error?: string;
}

export function importBackup(raw: unknown, actor: string): ImportBackupResult {
  const validated = validateBackupPayload(raw);
  if (!validated.ok) return { ok: false, error: validated.error };
  const b = validated.payload;
  const restored = prepareBackupRestore(b);

  Object.assign(state, restored);
  if (b.lastSchedulerRunAt) state.lastSchedulerRunAt = b.lastSchedulerRunAt;
  state.apiKeyBundleUsage = b.apiKeyBundleUsage ?? {};
  state.apiKeyOutcomeUsage = {};
  state.githubBudgetTelemetry = [];
  state.deviceActivity = b.deviceActivity?.slice(0, MAX_DEVICE_ACTIVITY) ?? [];
  replaceBillingSnapshot(b.billing);
  replaceIdentitySnapshot(b.identities);

  persistNow();
  recordAudit(
    actor,
    'state.import',
    'server state',
    `restored from backup exported ${b.exportedAt ? new Date(b.exportedAt).toISOString() : 'unknown time'}`,
  );
  return { ok: true };
}
