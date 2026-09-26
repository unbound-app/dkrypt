import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardJobListRoute, DashboardJobStatusRoute, DashboardJobTimelineRoute } from '#dashboardJobContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { canAccessProject, dashboardHistoryEntry } from '#dashboardJobPresentation.js';
import { getRouteContract } from '#contracts.js';
import { jobSummary } from '#jobs/http.js';
import { getJob } from '#jobs/store.js';
import type { Job } from '#jobs/types.js';
import type { DeviceTransport } from '#apiCommonContracts.js';
import { getFailureGuidance } from '#util/failureGuidance.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { DEFAULT_PROJECT_ID, getJobHistoryEntryById, getJobHistoryPage } from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

type TimelineSource = {
  id: string;
  correlationId?: string;
  bundleId: string;
  status: Job['status'];
  versionLabel?: string;
  deviceId?: string;
  transport?: DeviceTransport;
  fileSizeBytes?: number;
  sizeBytes?: number;
  warnings?: string[];
  ipaMetadata?: Job['ipaMetadata'];
  ipaInfoPlist?: Job['ipaInfoPlist'];
  timeline?: Job['timeline'];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
};

function dashboardJobTimeline(source: TimelineSource) {
  const events = source.timeline ?? [
    { at: source.createdAt, label: 'Queued', status: 'queued' as const },
    ...(source.startedAt !== undefined ? [{ at: source.startedAt, label: `Started on ${source.deviceId ?? 'unknown device'}`, status: 'running' as const }] : []),
    ...(source.finishedAt !== undefined
      ? [{ at: source.finishedAt, label: source.status === 'done' ? 'Finished' : `Failed: ${source.error ?? 'unknown error'}`, status: source.status === 'done' ? 'done' as const : 'failed' as const }]
      : []),
  ];
  return {
    id: source.id,
    correlationId: source.correlationId ?? source.id,
    bundleId: source.bundleId,
    status: source.status,
    versionLabel: source.versionLabel,
    deviceId: source.deviceId,
    transport: source.transport,
    sizeBytes: source.fileSizeBytes ?? source.sizeBytes,
    warnings: source.warnings,
    ipaMetadata: source.ipaMetadata,
    ipaInfoPlist: source.ipaInfoPlist,
    events,
    guidance: source.status === 'failed' ? getFailureGuidance(source.error) : undefined,
  };
}

export const dashboardJobRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardJobListRoute>('/v1/dashboard/jobs', { schema: getRouteContract('GET', '/v1/dashboard/jobs') }, async (request, reply) => {
    const session = getFastifySession(request)!;
    const query = request.query;
    const projectId = query.projectId ?? DEFAULT_PROJECT_ID;
    if (!canAccessProject(session.sub, session.permissions, projectId)) {
      return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'project not found'));
    }
    const limit = Math.min(query.limit ?? 15, 100);
    const cursor = query.cursor;
    const offset = cursor ? 0 : query.offset ?? 0;
    const q = query.q?.trim().slice(0, 200) || undefined;
    const queuedBy = query.queuedBy?.trim().slice(0, 120) || undefined;
    const deviceId = query.deviceId?.trim().slice(0, 64) || undefined;
    const errorQ = query.errorQ?.trim().slice(0, 200) || undefined;
    const failureCategory = query.failureCategory?.trim().slice(0, 64) || undefined;
    const { entries, total, nextCursor } = getJobHistoryPage(offset, limit, {
      projectId,
      bundleIdSearch: q,
      source: query.source,
      status: query.status,
      queuedBy,
      deviceId,
      errorSearch: errorQ,
      failureCategory,
      fromTs: query.fromTs,
      toTs: query.toTs,
    }, cursor);
    return { history: entries.map(dashboardHistoryEntry), total, nextCursor };
  });

  server.get<DashboardJobStatusRoute>('/v1/dashboard/jobs/:id/status', { schema: getRouteContract('GET', '/v1/dashboard/jobs/:id/status') }, async (request, reply) => {
    const session = getFastifySession(request)!;
    const job = getJob(request.params.id);
    if (!job || !canAccessProject(session.sub, session.permissions, job.projectId ?? DEFAULT_PROJECT_ID)) {
      return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'job not found (finished jobs are pruned after retention window)'));
    }
    return jobSummary(job);
  });

  server.get<DashboardJobTimelineRoute>('/v1/dashboard/jobs/:id/timeline', { schema: getRouteContract('GET', '/v1/dashboard/jobs/:id/timeline') }, async (request, reply) => {
    const session = getFastifySession(request)!;
    const active = getJob(request.params.id);
    if (active && canAccessProject(session.sub, session.permissions, active.projectId ?? DEFAULT_PROJECT_ID)) {
      return dashboardJobTimeline(active);
    }

    const entry = getJobHistoryEntryById(request.params.id);
    if (!entry || !canAccessProject(session.sub, session.permissions, entry.projectId ?? DEFAULT_PROJECT_ID)) {
      return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'job not found'));
    }
    return dashboardJobTimeline(entry);
  });
};
