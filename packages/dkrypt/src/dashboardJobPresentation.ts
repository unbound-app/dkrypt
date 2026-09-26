import { getAuthProfile } from '#identity.js';
import { jobFileAvailable } from '#jobs/http.js';
import { getJob } from '#jobs/store.js';
import { artifactFileAvailable, getArtifactById, getArtifactBySourceJobId, getArtifactForJob } from '#artifacts.js';
import { hasPermission, PermissionFlag } from '#permissions.js';
import { getProject, userCanAccessProject, type JobHistoryEntry } from '#store/state.js';

export function canViewAllProjects(permissions: bigint): boolean {
  return hasPermission(permissions, PermissionFlag.viewProjects) || hasPermission(permissions, PermissionFlag.manageProjects);
}

export function canAccessProject(userId: string, permissions: bigint, projectId: string): boolean {
  if (!getProject(projectId)) return false;
  return canViewAllProjects(permissions) || userCanAccessProject(userId, projectId);
}

export function dashboardHistoryEntry(entry: JobHistoryEntry) {
  const job = getJob(entry.id);
  const artifact =
    (entry.artifactId ? getArtifactById(entry.artifactId) : undefined) ??
    (job ? getArtifactForJob(job) : undefined) ??
    getArtifactBySourceJobId(entry.id);
  const fileAvailable = artifact ? artifactFileAvailable(artifact) : jobFileAvailable(job);
  return {
    ...entry,
    requester: dashboardJobRequester(entry),
    downloadUrl: artifact && fileAvailable ? `/v1/dashboard/artifacts/${encodeURIComponent(artifact.id)}/file` : undefined,
    fileAvailable,
  };
}

function dashboardJobRequester(entry: JobHistoryEntry) {
  if (entry.source === 'scheduler') return { displayName: 'System', avatarUrl: '/favicon.svg' };
  if (!entry.queuedBy) return { displayName: 'Unknown' };
  const profile = getAuthProfile(entry.queuedBy);
  return {
    username: profile?.username ?? entry.queuedBy,
    displayName: profile?.displayName ?? entry.queuedBy,
    avatarUrl: profile?.avatarUrl,
  };
}
