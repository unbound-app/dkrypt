import { hasPermission, isSubsetPermission, PermissionFlag } from '#permissions.js';

export function canGrantBits(actorBits: bigint, targetBits: bigint): boolean {
  return hasPermission(actorBits, PermissionFlag.manageRoles) || isSubsetPermission(targetBits, actorBits);
}
