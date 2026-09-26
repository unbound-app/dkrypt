import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardNotificationReadRoute, DashboardNotificationsListRoute } from '#dashboardNotificationContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { listNotificationsPage, markNotificationsRead } from '#store/state.js';

export const dashboardNotificationRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardNotificationsListRoute>('/v1/dashboard/notifications', { schema: getRouteContract('GET', '/v1/dashboard/notifications') }, async (request) => {
    const session = getFastifySession(request)!;
    const { cursor, limit, offset } = request.query;
    return listNotificationsPage(session.sub, cursor ? 0 : offset ?? 0, Math.min(limit ?? 50, 100), cursor);
  });

  server.post<DashboardNotificationReadRoute>('/v1/dashboard/notifications/read', { schema: getRouteContract('POST', '/v1/dashboard/notifications/read') }, async (request) => {
    const userId = getFastifySession(request)!.sub;
    return { ok: true, marked: markNotificationsRead(userId, request.body.ids) };
  });
};
