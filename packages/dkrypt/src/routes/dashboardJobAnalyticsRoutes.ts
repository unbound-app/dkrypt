import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardJobEtaRoute, DashboardJobSloRoute, DashboardJobStatsRoute, DashboardJobVolumeRoute } from '#dashboardJobContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { config } from '#config.js';
import { getRouteContract } from '#contracts.js';
import { getActiveJobs, getQueueInfo } from '#jobs/store.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { DEFAULT_PROJECT_ID, getAllJobHistory, getAverageJobDurationMs, getBundleStats, getDailyVolume } from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

interface DashboardJobAnalyticsServices {
  canAccessProject: typeof canAccessProject;
  getActiveJobs: typeof getActiveJobs;
  getAllJobHistory: typeof getAllJobHistory;
  getAverageJobDurationMs: typeof getAverageJobDurationMs;
  getBundleStats: typeof getBundleStats;
  getDailyVolume: typeof getDailyVolume;
  getQueueInfo: typeof getQueueInfo;
  queueSloMinutes: number;
}

const defaultServices: DashboardJobAnalyticsServices = {
  canAccessProject,
  getActiveJobs,
  getAllJobHistory,
  getAverageJobDurationMs,
  getBundleStats,
  getDailyVolume,
  getQueueInfo,
  queueSloMinutes: config.queueSloMinutes,
};

const canViewJobSlo = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);

export function createDashboardJobAnalyticsRoutes(overrides: Partial<DashboardJobAnalyticsServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardJobEtaRoute>('/v1/dashboard/jobs/eta/:bundleId', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/eta/:bundleId'),
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
      if (!services.canAccessProject(session.sub, session.permissions, projectId)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'project not found');
      }
      return { avgMs: services.getAverageJobDurationMs(request.params.bundleId, projectId) ?? null };
    });

    server.get<DashboardJobStatsRoute>('/v1/dashboard/jobs/stats/:bundleId', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/stats/:bundleId'),
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
      if (!services.canAccessProject(session.sub, session.permissions, projectId)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'project not found');
      }
      return services.getBundleStats(request.params.bundleId, projectId);
    });

    server.get<DashboardJobVolumeRoute>('/v1/dashboard/jobs/volume', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/volume'),
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
      if (!services.canAccessProject(session.sub, session.permissions, projectId)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'project not found');
      }
      return { days: services.getDailyVolume(request.query.days ?? 14, projectId) };
    });

    server.get<DashboardJobSloRoute>('/v1/dashboard/jobs/slo', {
      schema: getRouteContract('GET', '/v1/dashboard/jobs/slo'),
      preHandler: canViewJobSlo,
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
      if (!services.canAccessProject(session.sub, session.permissions, projectId)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'project not found');
      }
      const now = Date.now();
      const completed = services.getAllJobHistory().filter((job) =>
        (job.projectId ?? DEFAULT_PROJECT_ID) === projectId && job.status === 'done' && job.startedAt && job.finishedAt > job.startedAt,
      );
      const durations = completed.map((job) => job.finishedAt - (job.startedAt as number)).sort((a, b) => a - b);
      const historicalP95Ms = durations.length === 0 ? null : durations[Math.ceil(durations.length * 0.95) - 1]!;
      const targetMs = historicalP95Ms ?? services.queueSloMinutes * 60_000;
      const jobs = services.getActiveJobs()
        .filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId)
        .map((job) => {
          const queue = job.status === 'queued' ? services.getQueueInfo(job.id) : undefined;
          const waitedMs = now - job.createdAt;
          const predictedStartMs = queue && historicalP95Ms !== null ? Math.max(0, queue.position - 1) * historicalP95Ms : null;
          const predictedCompletionMs = predictedStartMs === null || historicalP95Ms === null ? null : predictedStartMs + historicalP95Ms;
          return {
            id: job.id,
            bundleId: job.bundleId,
            status: job.status,
            waitedMs,
            predictedStartMs,
            predictedCompletionMs,
            objective: waitedMs > targetMs || (predictedCompletionMs !== null && waitedMs + predictedCompletionMs > targetMs) ? 'breached' as const : 'within' as const,
          };
        });
      return { targetMs, historicalP95Ms, jobs };
    });
  };
}

export const dashboardJobAnalyticsRoutes = createDashboardJobAnalyticsRoutes();
