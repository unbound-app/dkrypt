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

export type PermissionGroup = 'General' | 'API Keys' | 'Scheduler & Dispatch' | 'Apple Authentication' | 'Users & Roles';

export interface PermissionMeta {
  key: PermissionFlagKey;
  label: string;
  description: string;
  group: PermissionGroup;
}

// Single source of truth for the role editor's copy/grouping. No implied-permission coupling
// here - Administrator is the one bit that shortcuts every check, everything else is independent.
export const PERMISSION_META: PermissionMeta[] = [
  { key: 'administrator', label: 'Administrator', description: 'Bypasses every other permission check - full, unrestricted access', group: 'General' },
  { key: 'requestDecrypt', label: 'Decrypt apps', description: 'Queue decrypts and manage their own jobs', group: 'General' },
  { key: 'viewLogs', label: 'View logs', description: 'See the live scheduler/job log feed and webhook delivery log', group: 'General' },
  { key: 'viewApiKeys', label: 'View all keys', description: 'See every key across every user, not just their own', group: 'API Keys' },
  { key: 'approveApiKeys', label: 'Approve requests', description: 'Approve or deny pending key requests; their own requests auto-approve', group: 'API Keys' },
  { key: 'revokeApiKeys', label: "Revoke anyone's key", description: "Revoke or bulk-revoke any user's key, not just their own", group: 'API Keys' },
  { key: 'manageApiKeyLimits', label: 'Manage key limits', description: 'Bulk-extend expiry and set daily limits/priority on keys', group: 'API Keys' },
  { key: 'accessApi', label: 'Use the API', description: 'Create personal API keys and use API endpoints', group: 'API Keys' },
  { key: 'manageWatches', label: 'Manage watches', description: 'Create, edit, and delete app watches', group: 'Scheduler & Dispatch' },
  { key: 'manageDevices', label: 'Manage devices', description: 'Create, edit, and delete devices in the decrypt pool', group: 'Scheduler & Dispatch' },
  { key: 'manageSchedulerSettings', label: 'Manage scheduler settings', description: 'Edit notification settings and the poll cron', group: 'Scheduler & Dispatch' },
  { key: 'triggerDispatch', label: 'Trigger dispatch', description: 'Run scheduler checks/previews, test webhook, dismiss auth alerts', group: 'Scheduler & Dispatch' },
  { key: 'manageAppleAuth', label: 'Apple ID re-authentication', description: 'Runs Apple sign-in with real credentials', group: 'Apple Authentication' },
  { key: 'viewUsers', label: 'View allowlist', description: 'See who has access, their roles, and the audit log', group: 'Users & Roles' },
  { key: 'manageUsers', label: 'Manage allowlist', description: "Add or remove people, assign roles to them", group: 'Users & Roles' },
  { key: 'manageRoles', label: 'Manage roles', description: 'Create, edit, delete, and reorder roles and what they grant', group: 'Users & Roles' },
  { key: 'manageBackup', label: 'Manage backups', description: 'Export and import a full server state backup', group: 'Users & Roles' },
];

export function permissionLabels(bits: bigint): string[] {
  if (hasPermission(bits, PermissionFlag.administrator)) return ['Administrator'];
  return PERMISSION_META.filter((f) => f.key !== 'administrator' && (bits & PermissionFlag[f.key]) !== 0n).map((f) => f.label);
}
