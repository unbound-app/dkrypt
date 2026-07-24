import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import type { TestFlightJobSource } from '#jobs/types.js';
import { categorizeFailure } from '#util/failureCategory.js';
import { combineBits, hasPermission, parseBits, PermissionFlag, serializeBits } from '#permissions.js';

export type ApiKeyStatus = 'pending' | 'approved' | 'denied';

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
  notifyOnKeyRequest: boolean;
  notifyOnDispatchSuccess: boolean;
  notifyOnDispatchFailure: boolean;
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

export interface AppWatch {
  id: string;
  name?: string;
  bundleId: string;
  repo: string;
  ghWorkflowFile: string;
  pollCron: string;
  enabled: boolean;
  webhookUrl?: string;
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

export interface UserPrefs {
  theme?: 'dark' | 'light' | 'auto';
  density?: 'comfortable' | 'compact';
  accent?: string;
  pushOnSuccess?: boolean;
  pushOnFailure?: boolean;
  pushOnAlerts?: boolean;
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
  | 'device.remove'
  | 'role.add'
  | 'role.update'
  | 'role.remove'
  | 'backup.schedule-update'
  | 'backup.create'
  | 'backup.delete';

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
  maxDownloads?: number;
  downloadCount: number;
  usedAt?: number;
  lastUsedAt?: number;
}

interface PersistedState {
  version: 11;
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
  pushSubscriptions: Record<string, PushSubscriptionRecord[]>;
  vapidKeys?: VapidKeys;
  apiKeyBundleUsage: Record<string, Record<string, number>>;
  shareLinks: ShareLinkRecord[];
  webhookDeliveryLog: WebhookDeliveryEntry[];
  discordRolePerks: DiscordRolePerk[];
  discordGuilds: DiscordGuildConfiguration[];
  backupSchedule: BackupScheduleSettings;
  backupHistory: BackupHistoryEntry[];
  activeSessions: ActiveSessionRecord[];
}

const MAX_HISTORY = 100;
const MAX_AUDIT_LOG = 200;
const MAX_SCHEDULER_RUNS = 20;
const MAX_SHARE_LINKS = 200;
const MAX_USAGE_DAYS = 30;
const MAX_DEVICE_HEALTH_CHECKS = 288;
const MAX_WEBHOOK_LOG = 200;
const statePath = path.join(config.stateDir, 'state.json');
const backupsDir = path.join(config.stateDir, 'backups');

function defaultState(): PersistedState {
  return {
    version: 11,
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
    pushSubscriptions: {},
    apiKeyBundleUsage: {},
    shareLinks: [],
    webhookDeliveryLog: [],
    discordRolePerks: [],
    discordGuilds: [],
    backupSchedule: { enabled: false, cron: '0 3 * * *', retentionCount: 14 },
    backupHistory: [],
    activeSessions: [],
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

function migrateV10ToV11(v10: Record<string, unknown>): PersistedState {
  const v10State = migrateV9ToV10(v10);
  return {
    ...v10State,
    version: 11,
    roles: (v10State.roles as Role[]).map((role) => ({ ...role, permissions: serializeBits(consolidatePermissionBits(parseBits(role.permissions))) })),
  } as PersistedState;
}

function migrate(raw: Record<string, unknown>): PersistedState {
  if (raw.version === 11) return { ...defaultState(), ...raw } as PersistedState;
  if (raw.version === 10) return migrateV10ToV11(raw);
  if (raw.version === 9) return migrateV10ToV11(raw);
  if (raw.version === 8) return migrateV10ToV11(migrateV8ToV9(raw));
  if (raw.version === 7) return migrateV10ToV11(migrateV8ToV9(migrateV7ToV8(raw)));
  if (raw.version === 6) return migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(raw)));
  if (raw.version === 5) return migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(migrateV5ToV6(raw))));

  if (raw.version === 4) {
    const v4Users = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
      migrateV5ToV6({
        ...raw,
        version: 5,
        allowedUsers: v4Users.map((u) => ({
          username: u.username as string,
          permissions: migratePermissionsV4(u.permissions as LegacyV4Permissions),
          addedAt: u.addedAt as number,
        })),
      }),
    )));
  }

  if (raw.version === 3) {
    const v3Users = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
      migrateV5ToV6({
        ...raw,
        version: 5,
        allowedUsers: v3Users.map((u) => ({
          username: u.username as string,
          permissions: migratePermissionsV3(u.permissions as LegacyV3Permissions),
          addedAt: u.addedAt as number,
        })),
      }),
    )));
  }

  if (raw.version === 2) {
    const legacyUsers = Array.isArray(raw.allowedUsers) ? (raw.allowedUsers as Record<string, unknown>[]) : [];
    return migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
      migrateV5ToV6({
        ...raw,
        version: 5,
        allowedUsers: legacyUsers.map((u) => ({
          username: u.username as string,
          permissions: legacyRoleToPermissions(String(u.role ?? '')),
          addedAt: u.addedAt as number,
        })),
      }),
    )));
  }

  const legacyKeys = Array.isArray(raw.apiKeys) ? (raw.apiKeys as Record<string, unknown>[]) : [];
  return migrateV10ToV11(migrateV8ToV9(migrateV6ToV8(
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
  )));
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
  setInterval(() => {
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
  for (const link of state.shareLinks) {
    if (link.issuedBy === sourceId) link.issuedBy = targetId;
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
    notifyOnKeyExpiringSoon: state.settings.notifyOnKeyExpiringSoon ?? true,
    notifyOnDeviceOffline: state.settings.notifyOnDeviceOffline ?? true,
    notifyOnDeviceBatteryHot: state.settings.notifyOnDeviceBatteryHot ?? true,
    notifyOnDeviceBatteryLow: state.settings.notifyOnDeviceBatteryLow ?? true,
    notifyOnDiskFull: state.settings.notifyOnDiskFull ?? true,
    notifyOnDeviceStorageLow: state.settings.notifyOnDeviceStorageLow ?? true,
    notifyOnTestFlightBridgeDown: state.settings.notifyOnTestFlightBridgeDown ?? true,
    notifyOnJobCompleted: state.settings.notifyOnJobCompleted ?? false,
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
  name?: string;
  bundleId: string;
  repo: string;
  ghWorkflowFile: string;
  pollCron: string;
  enabled?: boolean;
  webhookUrl?: string;
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
    repo: input.repo,
    ghWorkflowFile: input.ghWorkflowFile,
    pollCron: input.pollCron,
    enabled: input.enabled ?? true,
    webhookUrl: input.webhookUrl,
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
  return watch.enabled && watch.bundleId !== '' && watch.repo !== '' && config.ghToken !== '';
}

export function getWatchConfigIssues(watch: AppWatch): string[] {
  const fieldsSet = [watch.bundleId, watch.repo].filter(Boolean).length;
  const issues: string[] = [];

  if (fieldsSet > 0 && fieldsSet < 2) {
    const missing = [!watch.bundleId && 'watch bundle ID', !watch.repo && 'repo'].filter((v): v is string => typeof v === 'string');
    issues.push(`Watch is partially configured - still missing ${missing.join(', ')}.`);
  }

  if (fieldsSet === 2 && config.ghToken === '') {
    issues.push('Repo is configured but GH_TOKEN is not set - this watch will never actually run.');
  }

  return issues;
}

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
      (!fromTs || e.finishedAt >= fromTs) &&
      (!toTs || e.finishedAt <= toTs),
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
  byDevice: DeviceThroughputStats[];
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
    byDevice: getDeviceThroughput(),
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
  name?: string;
  bundleId: string;
  schedulable: boolean;
  lastCheckAt?: number;
  lastCheckOk?: boolean;
  consecutiveFailures: number;
  everTriggeredInHistory: boolean;
  historyCount: number;
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
    return {
      watchId: watch.id,
      name: watch.name,
      bundleId: watch.bundleId,
      schedulable: isWatchSchedulable(watch),
      lastCheckAt: last?.ts,
      lastCheckOk: last ? last.appStore.ok && last.testflight.ok : undefined,
      consecutiveFailures,
      everTriggeredInHistory: entries.some((e) => e.appStore.triggered || e.testflight.triggered),
      historyCount: entries.length,
    };
  });
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

export function recordShareLink(
  jobId: string,
  bundleId: string,
  token: string,
  issuedBy: string,
  expiresAt: number,
  maxDownloads?: number,
): ShareLinkRecord {
  const record: ShareLinkRecord = {
    id: randomUUID(),
    jobId,
    bundleId,
    token,
    issuedBy,
    issuedAt: Date.now(),
    expiresAt,
    revoked: false,
    downloadCount: 0,
    maxDownloads: maxDownloads && maxDownloads > 0 ? maxDownloads : undefined,
  };
  state.shareLinks.push(record);
  if (state.shareLinks.length > MAX_SHARE_LINKS) state.shareLinks.shift();
  persistNow();
  return record;
}

export function shareLinkDownloadUrl(l: ShareLinkRecord): string {
  return `${config.publicBaseUrl}/v1/jobs/${l.jobId}/file?token=${l.token}`;
}

function shareLinkExhausted(l: ShareLinkRecord): boolean {
  return l.maxDownloads !== undefined && (l.downloadCount ?? 0) >= l.maxDownloads;
}

function redactShareLink(l: ShareLinkRecord, revealUrl: boolean) {
  return {
    id: l.id,
    jobId: l.jobId,
    bundleId: l.bundleId,
    issuedBy: l.issuedBy,
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    revoked: l.revoked,
    maxDownloads: l.maxDownloads,
    downloadCount: l.downloadCount ?? 0,
    usedAt: l.usedAt,
    lastUsedAt: l.lastUsedAt,
    url: revealUrl ? shareLinkDownloadUrl(l) : undefined,
  };
}

export function listShareLinksForJob(jobId: string, viewerId: string): ReturnType<typeof redactShareLink>[] {
  return state.shareLinks
    .filter((l) => l.jobId === jobId)
    .sort((a, b) => b.issuedAt - a.issuedAt)
    .map((l) => redactShareLink(l, l.issuedBy === viewerId));
}

export function listAllShareLinks(): ReturnType<typeof redactShareLink>[] {
  return [...state.shareLinks].sort((a, b) => b.issuedAt - a.issuedAt).map((l) => redactShareLink(l, true));
}

export function revokeShareLink(id: string): boolean {
  const record = state.shareLinks.find((l) => l.id === id);
  if (!record) return false;
  record.revoked = true;
  persistNow();
  return true;
}

export interface UpdateShareLinkResult {
  ok: boolean;
  error?: string;
  link?: ReturnType<typeof redactShareLink>;
}

export function updateShareLink(id: string, updates: { expiresAt?: number; maxDownloads?: number | null }, allowExtend: boolean): UpdateShareLinkResult {
  const record = state.shareLinks.find((l) => l.id === id);
  if (!record) return { ok: false, error: 'share link not found' };
  if (record.revoked) return { ok: false, error: 'this share link has been revoked' };

  if (updates.expiresAt !== undefined) {
    if (updates.expiresAt > record.expiresAt && !allowExtend) {
      return { ok: false, error: 'extending a share link’s expiry requires additional permission' };
    }
    record.expiresAt = updates.expiresAt;
  }

  if (updates.maxDownloads !== undefined) {
    record.maxDownloads = updates.maxDownloads === null ? undefined : updates.maxDownloads;
  }

  persistNow();
  return { ok: true, link: redactShareLink(record, true) };
}

export function revokeAllShareLinksForJob(jobId: string): number {
  const now = Date.now();
  let revoked = 0;
  for (const l of state.shareLinks) {
    if (l.jobId === jobId && !l.revoked && l.expiresAt > now) {
      l.revoked = true;
      revoked += 1;
    }
  }
  if (revoked > 0) persistNow();
  return revoked;
}

export function isShareLinkRevoked(jobId: string, token: string): boolean {
  return state.shareLinks.some((l) => l.jobId === jobId && l.token === token && l.revoked);
}

export function shareLinkExistsForToken(jobId: string, token: string): boolean {
  return state.shareLinks.some((l) => l.jobId === jobId && l.token === token);
}

export function isShareLinkExpired(jobId: string, token: string): boolean {
  const record = state.shareLinks.find((l) => l.jobId === jobId && l.token === token);
  return record ? record.expiresAt <= Date.now() : false;
}

export function latestActiveShareLinkExpiry(jobId: string): number | undefined {
  const now = Date.now();
  let latest: number | undefined;
  for (const l of state.shareLinks) {
    if (l.jobId === jobId && !l.revoked && l.expiresAt > now && !shareLinkExhausted(l) && (latest === undefined || l.expiresAt > latest)) {
      latest = l.expiresAt;
    }
  }
  return latest;
}

export function isShareLinkExhausted(jobId: string, token: string): boolean {
  const record = state.shareLinks.find((l) => l.jobId === jobId && l.token === token);
  return record ? shareLinkExhausted(record) : false;
}

export function recordShareLinkDownload(jobId: string, token: string): void {
  const record = state.shareLinks.find((l) => l.jobId === jobId && l.token === token);
  if (!record) return;
  const now = Date.now();
  record.downloadCount = (record.downloadCount ?? 0) + 1;
  if (!record.usedAt) record.usedAt = now;
  record.lastUsedAt = now;
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

const BACKUP_VERSION = 4;

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
  writeFileSync(path.join(backupsDir, filename), json);

  const entry: BackupHistoryEntry = { id, createdAt: payload.exportedAt, sizeBytes: Buffer.byteLength(json), filename, trigger };
  state.backupHistory = [entry, ...state.backupHistory];
  const retention = Math.max(1, state.backupSchedule.retentionCount);
  while (state.backupHistory.length > retention) {
    const removed = state.backupHistory.pop();
    if (!removed) break;
    const filePath = path.join(backupsDir, removed.filename);
    if (existsSync(filePath)) rmSync(filePath);
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

export function deleteBackupSnapshot(id: string, actor: string): boolean {
  const idx = state.backupHistory.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  const [removed] = state.backupHistory.splice(idx, 1);
  const filePath = path.join(backupsDir, removed.filename);
  if (existsSync(filePath)) rmSync(filePath);
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
    u.roleIds.every((id) => typeof id === 'string')
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
  billing: BillingSnapshot;
  identities: IdentitySnapshot;
}

function validateBackupPayload(raw: unknown): { ok: true; payload: ValidatedBackupPayload } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'not a valid backup file' };
  const b = raw as Record<string, unknown>;

  if (b.backupVersion !== 3 && b.backupVersion !== BACKUP_VERSION) {
    return { ok: false, error: `unsupported backup version (expected 3 or ${BACKUP_VERSION})` };
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
  if (b.backupVersion === BACKUP_VERSION && !isBillingSnapshot(b.billing)) {
    return { ok: false, error: 'billing is missing or malformed' };
  }
  if (b.backupVersion === BACKUP_VERSION && !isIdentitySnapshot(b.identities)) {
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
      billing: isBillingSnapshot(b.billing) ? b.billing : { customers: [], subscriptions: [] },
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

export interface ImportBackupResult {
  ok: boolean;
  error?: string;
}

export function importBackup(raw: unknown, actor: string): ImportBackupResult {
  const validated = validateBackupPayload(raw);
  if (!validated.ok) return { ok: false, error: validated.error };
  const b = validated.payload;

  state.allowedUsers = b.allowedUsers;
  state.roles = b.roles.map((role) => ({ ...role, permissions: serializeBits(consolidatePermissionBits(upgradePermissionBits(parseBits(role.permissions)))) }));
  state.apiKeys = b.apiKeys.map((k) => ({ ...k, pendingReveal: undefined }));
  state.settings = b.settings;
  state.watches = b.watches;
  state.devices = b.devices;
  state.jobHistory = b.jobHistory.slice(0, MAX_HISTORY);
  state.auditLog = b.auditLog.slice(0, MAX_AUDIT_LOG);

  state.schedulerRunHistory = b.schedulerRunHistory
    .slice(0, MAX_SCHEDULER_RUNS)
    .map((e) => ({ ...e, id: e.id ?? randomUUID() }));
  state.userPrefs = b.userPrefs;
  state.apiKeyUsage = b.apiKeyUsage;
  state.rootSessionVersion = b.rootSessionVersion;
  if (b.lastSchedulerRunAt) state.lastSchedulerRunAt = b.lastSchedulerRunAt;
  state.apiKeyBundleUsage = b.apiKeyBundleUsage ?? {};
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
