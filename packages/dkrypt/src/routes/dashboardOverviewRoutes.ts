import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardOverviewRoute } from '#dashboardOverviewContracts.js';
import { buildDashboardOverview } from '#dashboardOverview.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { getRouteContract } from '#contracts.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { DEFAULT_PROJECT_ID } from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const validProjectId = /^[A-Za-z0-9_-]{1,80}$/;

export const dashboardOverviewRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardOverviewRoute>('/v1/dashboard/overview', {
    schema: getRouteContract('GET', '/v1/dashboard/overview'),
  }, (request, reply) => {
    const session = getFastifySession(request)!;
    const requestedProjectId = request.query.projectId;
    if (requestedProjectId !== undefined && !validProjectId.test(requestedProjectId)) {
      reply.code(400);
      return createHttpErrorEnvelope(request.id, 400, 'projectId must be a valid project identifier');
    }
    const projectId = requestedProjectId ?? DEFAULT_PROJECT_ID;
    if (!canAccessProject(session.sub, session.permissions, projectId)) {
      reply.code(404);
      return createHttpErrorEnvelope(request.id, 404, 'project not found');
    }
    return buildDashboardOverview(session.permissions, session.sub, projectId);
  });
};
