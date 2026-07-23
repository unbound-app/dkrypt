// Mirrors api/src/permissions.ts - every capability is its own bit, roles are a name + color +
// bitfield, and a member's effective permissions are the OR of every role they hold (plus the
// implicit @everyone role). Kept as a separate copy from the backend rather than a shared package
// since frontend and backend already don't share a build step in this repo.
export const PermissionFlag = {
  administrator: 1n << 0n,
  requestDecrypt: 1n << 1n,
  viewApiKeys: 1n << 2n,
  approveApiKeys: 1n << 3n,
  revokeApiKeys: 1n << 4n,
  manageApiKeyLimits: 1n << 5n,
  manageWatches: 1n << 6n,
  manageDevices: 1n << 7n,
  manageSchedulerSettings: 1n << 8n,
  triggerDispatch: 1n << 9n,
  manageAppleAuth: 1n << 10n,
  viewLogs: 1n << 11n,
  viewUsers: 1n << 12n,
  manageUsers: 1n << 13n,
  manageRoles: 1n << 14n,
  manageBackup: 1n << 15n,
  accessApi: 1n << 16n,
  viewRoles: 1n << 17n,
  viewDiscordPerks: 1n << 18n,
  manageDiscordPerks: 1n << 19n,
  viewScheduler: 1n << 20n,
  viewDevices: 1n << 21n,
  viewBackup: 1n << 22n,
  viewApiKeyUsage: 1n << 23n,
  manageApiKeyExpiry: 1n << 24n,
  manageApiKeyDailyLimits: 1n << 25n,
  manageApiKeyConcurrency: 1n << 26n,
  manageApiKeyTestFlight: 1n << 27n,
  manageApiKeyPriority: 1n << 28n,
} as const;

export type PermissionFlagKey = keyof typeof PermissionFlag;

export function hasPermission(bits: bigint, flag: bigint): boolean {
  return (bits & PermissionFlag.administrator) !== 0n || (bits & flag) !== 0n;
}

export function hasAnyPermission(bits: bigint, flags: bigint[]): boolean {
  return flags.some((flag) => hasPermission(bits, flag));
}

export function isSubsetPermission(subset: bigint, bits: bigint): boolean {
  if ((bits & PermissionFlag.administrator) !== 0n) return true;
  return (subset & bits) === subset;
}

export function combineBits(bits: bigint[]): bigint {
  return bits.reduce((acc, b) => acc | b, 0n);
}

export function serializeBits(bits: bigint): string {
  return bits.toString();
}

export function parseBits(value: string | undefined | null): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export type PermissionGroup = 'General' | 'API Keys' | 'Automation & Devices' | 'Apple Authentication' | 'Members & Roles' | 'Backups';

export interface PermissionMeta {
  key: PermissionFlagKey;
  label: string;
  description: string;
  group: PermissionGroup;
}

// Single source of truth for the role editor's copy/grouping. No implied-permission coupling
// here - Administrator is the one bit that shortcuts every check, everything else is independent.
export const PERMISSION_META: PermissionMeta[] = [
  { key: 'administrator', label: 'Administrator', description: 'Grants every current and future dashboard permission. This bypasses every individual permission check and should be limited to fully trusted operators.', group: 'General' },
  { key: 'requestDecrypt', label: 'Request and manage own decrypts', description: 'Submit manual and TestFlight decrypt requests, then cancel, prioritize, retry, download, and share only jobs owned by this account.', group: 'General' },
  { key: 'viewLogs', label: 'View operational logs', description: 'Read the live scheduler and job log stream plus webhook delivery records. This does not grant permission to change automation or webhook settings.', group: 'General' },
  { key: 'accessApi', label: 'Use personal API keys', description: 'Create, reveal, regenerate, revoke, and use API keys owned by this account. It never exposes or changes another user’s keys.', group: 'API Keys' },
  { key: 'viewApiKeys', label: 'View every API key', description: 'Read the full key inventory, including ownership, status, configuration, and activity metadata. Secrets are never returned by this permission.', group: 'API Keys' },
  { key: 'viewApiKeyUsage', label: 'View API-key usage', description: 'Read request and bundle usage metrics for keys visible to the account. This does not allow changing a key or its limits.', group: 'API Keys' },
  { key: 'approveApiKeys', label: 'Approve or deny API-key requests', description: 'Review pending key requests and change their status to approved or denied. It does not grant access to edit approved-key limits.', group: 'API Keys' },
  { key: 'revokeApiKeys', label: 'Revoke any API key', description: 'Revoke one or many keys belonging to any user. It does not allow creating keys, editing limits, or approving requests.', group: 'API Keys' },
  { key: 'manageApiKeyExpiry', label: 'Set API-key expiry', description: 'Set or bulk-extend the expiration time of approved keys. This permission does not alter quotas, concurrency, or API-key status.', group: 'API Keys' },
  { key: 'manageApiKeyDailyLimits', label: 'Set API-key daily limits', description: 'Set the maximum number of API requests a key may make per day. It does not change expiry, concurrency, or TestFlight access.', group: 'API Keys' },
  { key: 'manageApiKeyConcurrency', label: 'Set API-key concurrency', description: 'Set the maximum number of simultaneous decrypt requests allowed for a key. It does not change daily quotas or priority.', group: 'API Keys' },
  { key: 'manageApiKeyTestFlight', label: 'Set API-key TestFlight access', description: 'Allow or block TestFlight requests for individual API keys. It does not grant access to other key settings.', group: 'API Keys' },
  { key: 'manageApiKeyPriority', label: 'Set API-key priority', description: 'Set a key’s queue priority for API-originated decrypt requests. It does not grant the ability to manage user queue priority.', group: 'API Keys' },
  { key: 'viewScheduler', label: 'View automation', description: 'Read watch configuration, scheduler state, and dispatch health without changing watches, devices, settings, or running a dispatch.', group: 'Automation & Devices' },
  { key: 'manageWatches', label: 'Manage app watches', description: 'Create, edit, and delete watched apps and their polling configuration. It does not grant access to scheduler-wide notification settings.', group: 'Automation & Devices' },
  { key: 'viewDevices', label: 'View devices', description: 'Read decrypt-pool device configuration and health without adding, editing, removing, or operating devices.', group: 'Automation & Devices' },
  { key: 'manageDevices', label: 'Manage devices', description: 'Create, edit, and delete decrypt-pool devices. It does not change automation configuration or Apple authentication.', group: 'Automation & Devices' },
  { key: 'manageSchedulerSettings', label: 'Manage scheduler settings', description: 'Change scheduler-wide notification delivery, polling, retry, alert, and retention settings. It does not create watches or trigger dispatches.', group: 'Automation & Devices' },
  { key: 'triggerDispatch', label: 'Run automation actions', description: 'Preview and trigger watch dispatches, test a webhook, and dismiss Apple-auth alerts. It does not modify saved configuration.', group: 'Automation & Devices' },
  { key: 'manageAppleAuth', label: 'Manage Apple authentication', description: 'Start, complete, and cancel Apple ID reauthentication using the configured credentials. It does not grant device or watch management.', group: 'Apple Authentication' },
  { key: 'viewUsers', label: 'View members', description: 'Read the allowlist, member details, and audit log. It does not grant the ability to add members, change roles, or alter any record.', group: 'Members & Roles' },
  { key: 'manageUsers', label: 'Manage members', description: 'Add allowlisted users, remove them, assign their dashboard roles, and set their manual queue priority. It does not grant role-definition access.', group: 'Members & Roles' },
  { key: 'viewRoles', label: 'View dashboard roles', description: 'Read role names, colors, membership counts, and granted permissions. It does not permit creating, editing, deleting, or reordering roles.', group: 'Members & Roles' },
  { key: 'manageRoles', label: 'Manage dashboard roles', description: 'Create, edit, delete, and reorder dashboard roles. A user can only grant permissions they already hold unless they also hold this permission.', group: 'Members & Roles' },
  { key: 'viewDiscordPerks', label: 'View Discord role perks', description: 'Read selected Discord guilds, discovered Discord roles, and existing Discord-to-dashboard role mappings. It does not change those mappings.', group: 'Members & Roles' },
  { key: 'manageDiscordPerks', label: 'Manage Discord role perks', description: 'Select Discord guilds and create or remove Discord-to-dashboard role mappings. It does not permit editing dashboard role permissions.', group: 'Members & Roles' },
  { key: 'viewBackup', label: 'View backups', description: 'Read backup schedules and history and download existing backup files. It does not create, delete, import, or change retention.', group: 'Backups' },
  { key: 'manageBackup', label: 'Manage backups', description: 'Export or import server state, create or delete backup snapshots, and change backup schedules and retention. It does not grant member or role management.', group: 'Backups' },
];

export function permissionLabels(bits: bigint): string[] {
  if (hasPermission(bits, PermissionFlag.administrator)) return ['Administrator'];
  return PERMISSION_META.filter((f) => f.key !== 'administrator' && (bits & PermissionFlag[f.key]) !== 0n).map((f) => f.label);
}
