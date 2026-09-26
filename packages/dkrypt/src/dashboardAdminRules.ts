import { hasPermission, isSubsetPermission, PermissionFlag } from '#permissions.js';

export function parseRoleIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) return undefined;
  return value;
}

export function canGrantBits(actorBits: bigint, targetBits: bigint): boolean {
  return hasPermission(actorBits, PermissionFlag.manageRoles) || isSubsetPermission(targetBits, actorBits);
}
