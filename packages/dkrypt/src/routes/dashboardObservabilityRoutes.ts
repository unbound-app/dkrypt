import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardAuditLogRoute, DashboardLogsRoute } from '#dashboardObservabilityContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { logBelongsToProject } from '#dashboardLogPresentation.js';
import { getRouteContract } from '#contracts.js';
import { getRecentLogs } from '#logger.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { DEFAULT_PROJECT_ID, getAuditLogPage } from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const canViewLogs = fastifyRequirePermission(PermissionFlag.viewLogs);
const canViewAuditLog = fastifyRequirePermission(PermissionFlag.viewUsers, PermissionFlag.manageUsers);

export const dashboardObservabilityRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardLogsRoute>('/v1/dashboard/logs', {
    schema: getRouteContract('GET', '/v1/dashboard/logs'),
    preHandler: canViewLogs,
  }, (request, reply) => {
    const session = getFastifySession(request)!;
    const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
    if (!canAccessProject(session.sub, session.permissions, projectId)) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'project not found');
    }
    const query = request.query;
    const scope = query.scope && query.scope !== 'all' ? query.scope.slice(0, 100) : undefined;
    const search = query.q?.trim().slice(0, 100) || undefined;
    const cursor = query.cursor;
    const offset = cursor ? 0 : query.offset ?? 0;
    const limit = Math.min(query.limit ?? 100, 200);
    try {
      return getRecentLogs({
        scope,
        level: query.level,
        query: search,
        regex: query.regex === '1',
        cursor,
        offset,
        limit,
        filter: (entry) => logBelongsToProject(entry, projectId),
      });
    } catch {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'log search pattern is invalid or unsafe');
    }
  });

  server.get<DashboardAuditLogRoute>('/v1/dashboard/audit-log', {
    schema: getRouteContract('GET', '/v1/dashboard/audit-log'),
    preHandler: canViewAuditLog,
  }, (request) => {
    const { cursor, limit, offset } = request.query;
    return getAuditLogPage(cursor ? 0 : offset ?? 0, Math.min(limit ?? 100, 200), cursor);
  });
};
