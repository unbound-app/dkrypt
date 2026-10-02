import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardIncidentRoute } from '#dashboardIncidentContracts.js';
import { dashboardIncidentQuerySchema, dashboardIncidentResponseSchema } from '#dashboardIncidentContracts.js';
import { getRecentLogs, type LogEntry } from '#logger.js';
import { getActiveJobs } from '#jobs/store.js';
import type { Job } from '#jobs/types.js';
import { logBelongsToProject } from '#dashboardLogPresentation.js';
import { PermissionFlag, hasPermission } from '#permissions.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { DEFAULT_PROJECT_ID, getAllJobHistory, getDeviceActivityPage, getEffectiveDevices, getProject, listNotifications, type DeviceActivityEntry, type DeviceRecord, type JobHistoryEntry, type NotificationRecord } from '#store/state.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

type IncidentEvent = {
  id: string;
  at: number;
  kind: 'device' | 'job' | 'deployment';
  title: string;
  detail?: string;
  jobId?: string;
  deviceId?: string;
  deploymentId?: string;
  correlationId?: string;
};

interface DashboardIncidentServices {
  canAccessProject: typeof canAccessProject;
  getProject: typeof getProject;
  getEffectiveDevices: typeof getEffectiveDevices;
  getDeviceActivityPage: typeof getDeviceActivityPage;
  getAllJobHistory: typeof getAllJobHistory;
  getActiveJobs: typeof getActiveJobs;
  getRecentLogs: typeof getRecentLogs;
  listNotifications: typeof listNotifications;
}

const defaultServices: DashboardIncidentServices = {
  canAccessProject,
  getProject,
  getEffectiveDevices,
  getDeviceActivityPage,
  getAllJobHistory,
  getActiveJobs,
  getRecentLogs,
  listNotifications,
};

function jobEvents(entry: JobHistoryEntry | Job, active: boolean, since: number): IncidentEvent[] {
  const timeline = entry.timeline ?? [];
  const events = timeline.filter((event) => event.at >= since).map((event, index) => ({
    id: `job:${entry.id}:${event.at}:${index}`,
    at: event.at,
    kind: 'job' as const,
    title: event.label,
    detail: `${entry.bundleId} · ${event.status}${active ? ' · active' : ''}`,
    jobId: entry.id,
    correlationId: entry.correlationId,
  }));
  if (events.length > 0 || entry.finishedAt === undefined || entry.finishedAt < since) return events;
  return [{
    id: `job:${entry.id}:finished`,
    at: entry.finishedAt,
    kind: 'job',
    title: `Job ${entry.status}`,
    detail: entry.bundleId,
    jobId: entry.id,
    correlationId: entry.correlationId,
  }];
}

function deviceEvent(entry: DeviceActivityEntry, device: DeviceRecord): IncidentEvent {
  return { id: `device:${entry.id}`, at: entry.ts, kind: 'device', title: entry.message, detail: [device.name, entry.bundleId].filter(Boolean).join(' · '), deviceId: device.id };
}

function deploymentEvent(notification: NotificationRecord): IncidentEvent {
  return { id: `deployment:${notification.deploymentId}`, at: notification.createdAt, kind: 'deployment', title: notification.title, detail: notification.message, deploymentId: notification.deploymentId };
}

function deploymentLogEvent(entry: LogEntry): IncidentEvent {
  const deploymentId = typeof entry.meta?.deploymentId === 'string' ? entry.meta.deploymentId : typeof entry.meta?.runId === 'string' ? entry.meta.runId : entry.id;
  return { id: `deployment-log:${entry.id}`, at: entry.ts, kind: 'deployment', title: entry.message, deploymentId };
}

export function createDashboardIncidentRoutes(overrides: Partial<DashboardIncidentServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };
  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardIncidentRoute>('/v1/dashboard/incidents', {
      schema: { hide: true, querystring: dashboardIncidentQuerySchema, response: { 200: dashboardIncidentResponseSchema } },
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
      const project = services.getProject(projectId);
      if (!project || !services.canAccessProject(session.sub, session.permissions, projectId)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'project not found');
      }
      const since = Math.max(request.query.since ?? Date.now() - 30 * 24 * 60 * 60 * 1000, Date.now() - 90 * 24 * 60 * 60 * 1000);
      const events: IncidentEvent[] = [];
      const canViewDevices = hasPermission(session.permissions, PermissionFlag.viewDevices) || hasPermission(session.permissions, PermissionFlag.manageDevices);
      const canViewJobs = hasPermission(session.permissions, PermissionFlag.requestDecrypt) || hasPermission(session.permissions, PermissionFlag.viewLogs);
      if (canViewDevices && projectId === DEFAULT_PROJECT_ID) {
        for (const device of services.getEffectiveDevices()) {
          const page = services.getDeviceActivityPage(device.id, 0, 1000);
          events.push(...page.entries.filter((entry) => entry.ts >= since).map((entry) => deviceEvent(entry, device)));
        }
      }
      if (canViewJobs) {
        for (const entry of services.getAllJobHistory()) {
          if ((entry.projectId ?? DEFAULT_PROJECT_ID) === projectId) events.push(...jobEvents(entry, false, since));
        }
        for (const entry of services.getActiveJobs()) {
          if ((entry.projectId ?? DEFAULT_PROJECT_ID) === projectId) events.push(...jobEvents(entry, true, since));
        }
      }
      const canViewDeployments = hasPermission(session.permissions, PermissionFlag.manageDevices) || hasPermission(session.permissions, PermissionFlag.viewLogs);
      if (canViewDeployments) {
        const logs = services.getRecentLogs({ limit: 500 }).logs.filter((entry) => /deploy/i.test(entry.scope) && entry.ts >= since && logBelongsToProject(entry, projectId));
        events.push(...logs.map(deploymentLogEvent));
        if (projectId === DEFAULT_PROJECT_ID) {
          events.push(...services.listNotifications(session.sub, 100).notifications.filter((entry) => entry.deploymentId && entry.createdAt >= since).map(deploymentEvent));
        }
      }
      const deduplicated = new Map<string, IncidentEvent>();
      for (const event of events) if (!deduplicated.has(event.id)) deduplicated.set(event.id, event);
      const sorted = [...deduplicated.values()].sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
      return { projectId, events: sorted.slice(0, 200), truncated: sorted.length > 200 };
    });
  };
}

export const dashboardIncidentRoutes = createDashboardIncidentRoutes();
