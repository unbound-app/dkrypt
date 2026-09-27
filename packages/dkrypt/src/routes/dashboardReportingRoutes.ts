import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import type { DashboardFailurePatternsRoute, DashboardInsightsRoute, DashboardStorageForecastRoute, DashboardSupportBundleRoute, DashboardWebhookDeliveriesRoute } from '#contracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { logBelongsToProject } from '#dashboardLogPresentation.js';
import { config } from '#config.js';
import { getRouteContract } from '#contracts.js';
import { getDeploymentMetadata } from '#deployment.js';
import { getRecentLogs } from '#logger.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession, type Session } from '#session.js';
import {
  DEFAULT_PROJECT_ID,
  getAllJobHistory,
  getAppCatalogStats,
  getEffectiveDevices,
  getEffectiveWatches,
  getInsightsSummary,
  getSchedulerRunHistory,
  getStateDatabaseStatus,
  getWatchDispatchTargets,
  getWatchHealthRollup,
  getWebhookDeliveryLog,
  verifyLatestDatabaseBackup,
} from '#store/state.js';
import { getDiskUsage } from '#util/diskUsage.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

interface DashboardReportingServices {
  canAccessProject: typeof canAccessProject;
  getInsightsSummary: (topAppsLimit: number, trendDays: number, projectId: string) => ReturnType<typeof getInsightsSummary>;
  getAllJobHistory: typeof getAllJobHistory;
  getDiskUsage: typeof getDiskUsage;
  artifactDir: string;
  getWebhookDeliveryLog: typeof getWebhookDeliveryLog;
  getStateDatabaseStatus: typeof getStateDatabaseStatus;
  verifyLatestDatabaseBackup: typeof verifyLatestDatabaseBackup;
  getAppCatalogStats: typeof getAppCatalogStats;
  getEffectiveDevices: typeof getEffectiveDevices;
  getEffectiveWatches: typeof getEffectiveWatches;
  getWatchDispatchTargets: typeof getWatchDispatchTargets;
  getWatchHealthRollup: typeof getWatchHealthRollup;
  getSchedulerRunHistory: typeof getSchedulerRunHistory;
  getRecentLogs: typeof getRecentLogs;
  logBelongsToProject: typeof logBelongsToProject;
}

const defaultServices: DashboardReportingServices = {
  canAccessProject,
  getInsightsSummary,
  getAllJobHistory,
  getDiskUsage,
  artifactDir: config.artifactDir,
  getWebhookDeliveryLog,
  getStateDatabaseStatus,
  verifyLatestDatabaseBackup,
  getAppCatalogStats,
  getEffectiveDevices,
  getEffectiveWatches,
  getWatchDispatchTargets,
  getWatchHealthRollup,
  getSchedulerRunHistory,
  getRecentLogs,
  logBelongsToProject,
};

function boundedQueryInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? String(fallback), 10) || fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

function projectAccessError(session: Session, projectId: string, requestId: string, reply: FastifyReply, canAccessProjectCheck: DashboardReportingServices['canAccessProject']) {
  if (canAccessProjectCheck(session.sub, session.permissions, projectId)) return undefined;
  reply.code(404);
  return createHttpErrorEnvelope(requestId, 404, 'project not found');
}

export function createDashboardReportingRoutes(overrides: Partial<DashboardReportingServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };
  const canViewScheduler = fastifyRequirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardInsightsRoute>('/v1/dashboard/insights', {
      schema: getRouteContract('GET', '/v1/dashboard/insights'),
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
      const accessError = projectAccessError(session, projectId, request.id, reply, services.canAccessProject);
      if (accessError) return accessError;
      return services.getInsightsSummary(
        boundedQueryInteger(request.query.topApps, 5, 1, 25),
        boundedQueryInteger(request.query.trendDays, 14, 1, 90),
        projectId,
      );
    });

    server.get<DashboardFailurePatternsRoute>('/v1/dashboard/failure-patterns', {
      schema: getRouteContract('GET', '/v1/dashboard/failure-patterns'),
      preHandler: canViewScheduler,
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
      const accessError = projectAccessError(session, projectId, request.id, reply, services.canAccessProject);
      if (accessError) return accessError;
      const normalize = (message: string) => message
        .replace(/https?:\/\/\S+/g, '[url]')
        .replace(/(?:authorization:\s*bearer\s+|(?:token|secret|key|cookie)\s*[:=]\s*)[^\s,;"']+/gi, '[redacted]')
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[id]')
        .replace(/\b\d{4,}\b/g, '[number]')
        .slice(0, 180);
      const patterns = new Map<string, { count: number; firstSeen: number; lastSeen: number; bundleIds: Set<string> }>();
      for (const job of services.getAllJobHistory().filter((entry) => (entry.projectId ?? DEFAULT_PROJECT_ID) === projectId && entry.status === 'failed' && entry.error)) {
        const key = normalize(job.error as string);
        const current = patterns.get(key) ?? { count: 0, firstSeen: job.finishedAt, lastSeen: job.finishedAt, bundleIds: new Set<string>() };
        current.count += 1;
        current.firstSeen = Math.min(current.firstSeen, job.finishedAt);
        current.lastSeen = Math.max(current.lastSeen, job.finishedAt);
        current.bundleIds.add(job.bundleId);
        patterns.set(key, current);
      }
      return {
        patterns: [...patterns.entries()]
          .map(([message, pattern]) => ({ message, count: pattern.count, firstSeen: pattern.firstSeen, lastSeen: pattern.lastSeen, bundleIds: [...pattern.bundleIds] }))
          .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen)
          .slice(0, 20),
      };
    });

    server.get<DashboardStorageForecastRoute>('/v1/dashboard/storage-forecast', {
      schema: getRouteContract('GET', '/v1/dashboard/storage-forecast'),
      preHandler: canViewScheduler,
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
      const accessError = projectAccessError(session, projectId, request.id, reply, services.canAccessProject);
      if (accessError) return accessError;
      const cutoff = Date.now() - 30 * 86_400_000;
      const completed = services.getAllJobHistory().filter((entry) => (entry.projectId ?? DEFAULT_PROJECT_ID) === projectId && entry.status === 'done' && entry.finishedAt >= cutoff && entry.sizeBytes && entry.sizeBytes > 0);
      const bytesPerDay = completed.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0) / 30;
      const disk = services.getDiskUsage(services.artifactDir);
      if (!disk) {
        reply.code(503);
        return createHttpErrorEnvelope(request.id, 503, 'output storage is unavailable');
      }
      return {
        freeBytes: disk.freeBytes,
        bytesPerDay,
        daysRemaining: bytesPerDay > 0 ? Math.floor(disk.freeBytes / bytesPerDay) : null,
        sampleCount: completed.length,
      };
    });

    server.get<DashboardWebhookDeliveriesRoute>('/v1/dashboard/webhooks', {
      schema: getRouteContract('GET', '/v1/dashboard/webhooks'),
      preHandler: fastifyRequirePermission(PermissionFlag.viewLogs),
    }, (request) => {
      const limit = Math.min(Math.max(Number.parseInt(request.query.limit ?? '100', 10) || 100, 1), 200);
      return { deliveries: services.getWebhookDeliveryLog(limit) };
    });

    server.get<DashboardSupportBundleRoute>('/v1/dashboard/support-bundle', {
      schema: getRouteContract('GET', '/v1/dashboard/support-bundle'),
      preHandler: fastifyRequirePermission(PermissionFlag.manageAutomation),
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
      const accessError = projectAccessError(session, projectId, request.id, reply, services.canAccessProject);
      if (accessError) return accessError;
      const redactSensitiveText = (value: string | undefined): string | undefined => value
        ?.replace(/https?:\/\/\S+/g, '[redacted-url]')
        .replace(/\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;"']+/gi, '$1[redacted]')
        .replace(/\b(authorization\s*[:=]\s*)(?!bearer\b|basic\b)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
        .replace(/\b((?:[\w-]*(?:token|secret|password|key|cookie|credential))\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]');
      const redactSensitiveData = (value: unknown): unknown => {
        if (typeof value === 'string') return redactSensitiveText(value) ?? value;
        if (Array.isArray(value)) return value.map(redactSensitiveData);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /authorization|token|secret|password|private.?key|cookie|credential|api.?key/i.test(key) ? '[redacted]' : redactSensitiveData(entry)]));
      };
      const watches = services.getEffectiveWatches().filter((watch) => (watch.projectId ?? DEFAULT_PROJECT_ID) === projectId);
      const watchIds = new Set(watches.map((watch) => watch.id));
      const bundleIds = new Set(watches.map((watch) => watch.bundleId));
      const jobs = services.getAllJobHistory()
        .filter((entry) => (entry.projectId ?? DEFAULT_PROJECT_ID) === projectId)
        .slice(0, 100)
        .map(({ id, correlationId, bundleId, status, source, versionLabel, createdAt, startedAt, finishedAt, sizeBytes, error }) => ({
          id,
          correlationId,
          bundleId,
          status,
          source,
          versionLabel,
          createdAt,
          startedAt,
          finishedAt,
          sizeBytes,
          error: redactSensitiveText(error),
        }));
      const logs = services.getRecentLogs({ limit: 200, filter: (entry) => services.logBelongsToProject(entry, projectId) }).logs;
      const transportTimeline = logs.filter((entry) => entry.scope === 'idevice').map((entry) => ({
        id: entry.id,
        at: entry.ts,
        level: entry.level,
        message: redactSensitiveText(entry.message) ?? entry.message,
        deviceId: typeof entry.meta?.deviceId === 'string' ? entry.meta.deviceId : undefined,
        transport: typeof entry.meta?.transport === 'string' ? entry.meta.transport : undefined,
        operation: typeof entry.meta?.operation === 'string' ? entry.meta.operation : undefined,
        correlationId: typeof entry.meta?.correlationId === 'string' ? entry.meta.correlationId : undefined,
      }));
      const correlationIds = [...new Set([
        ...jobs.flatMap((job) => typeof job.correlationId === 'string' ? [job.correlationId] : []),
        ...logs.flatMap((entry) => typeof entry.meta?.correlationId === 'string' ? [entry.meta.correlationId] : []),
      ])];
      const schedulerRuns = services.getSchedulerRunHistory(50).filter((run) => run.watchId ? watchIds.has(run.watchId) : Boolean(run.bundleId && bundleIds.has(run.bundleId)));
      reply.header('Content-Disposition', 'attachment; filename="dkrypt-support-bundle.json"');
      return {
        generatedAt: new Date().toISOString(),
        deployment: { ...getDeploymentMetadata(), node: process.version },
        database: services.getStateDatabaseStatus(),
        latestBackup: services.verifyLatestDatabaseBackup(),
        disk: services.getDiskUsage(services.artifactDir),
        catalog: services.getAppCatalogStats(),
        devices: services.getEffectiveDevices().map(({ id, name, enabled, isPrimary }) => ({ id, name, enabled, isPrimary })),
        watches: watches.map((watch) => ({ bundleId: watch.bundleId, enabled: watch.enabled, pollCron: watch.pollCron, destinations: services.getWatchDispatchTargets(watch).length })),
        watchHealth: services.getWatchHealthRollup().filter((health) => watchIds.has(health.watchId)),
        schedulerRuns: schedulerRuns.map((run) => ({ ...run, appStore: { ...run.appStore, reason: redactSensitiveText(run.appStore.reason) ?? '' }, testflight: { ...run.testflight, reason: redactSensitiveText(run.testflight.reason) ?? '' } })),
        logs: logs.map((entry) => ({ ...entry, message: redactSensitiveText(entry.message) ?? entry.message, meta: entry.meta ? redactSensitiveData(entry.meta) as Record<string, unknown> : undefined })),
        jobs,
        transportTimeline,
        correlationIds,
      };
    });
  };
}

export const dashboardReportingRoutes = createDashboardReportingRoutes();
