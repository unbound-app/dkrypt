import { hasPermission, PermissionFlag } from '#permissions.js';
import { getProject, getUserEffectivePermissions, userCanAccessProject, type ApiKeyAuthResult } from '#store/state.js';

export function isBundleIdAllowed(scope: string[] | undefined, bundleId: string): boolean {
  return !scope || scope.length === 0 || scope.includes(bundleId);
}

export function apiKeyCanAccessProject(apiKey: ApiKeyAuthResult | undefined, projectId: string, requireActive = false): boolean {
  if (apiKey?.projectId && apiKey.projectId !== projectId) return false;
  const project = getProject(projectId);
  if (!project || (requireActive && project.archivedAt !== undefined)) return false;
  if (!apiKey?.ownerId || apiKey.ownerId === 'root') return true;
  const permissions = getUserEffectivePermissions(apiKey.ownerId);
  if (hasPermission(permissions, PermissionFlag.viewProjects) || hasPermission(permissions, PermissionFlag.manageProjects)) return true;
  return project.archivedAt === undefined && userCanAccessProject(apiKey.ownerId, projectId);
}
