import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardEmailTestRoute, DashboardPrefsGetRoute, DashboardPrefsUpdateRoute, DashboardPushPublicKeyRoute, DashboardPushSubscribeRoute, DashboardPushTestRoute, DashboardPushUnsubscribeRoute } from '#dashboardAccountContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { getAuthProfile } from '#identity.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { resolveNotifyEmail, sendMailToUser } from '#mail.js';
import { getVapidPublicKey, sendPushToUser } from '#push.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { addPushSubscription, getUserPrefs, removePushSubscription, updateUserPrefs, type UserPrefs } from '#store/state.js';

export const dashboardAccountRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardPrefsGetRoute>('/v1/dashboard/me/prefs', { schema: getRouteContract('GET', '/v1/dashboard/me/prefs') }, async (request) => {
    const userId = getFastifySession(request)!.sub;
    return { ...getUserPrefs(userId), accountEmail: getAuthProfile(userId)?.email };
  });

  server.get<DashboardPushPublicKeyRoute>('/v1/dashboard/push/public-key', { schema: getRouteContract('GET', '/v1/dashboard/push/public-key') }, async () => ({ publicKey: getVapidPublicKey() }));

  server.post<DashboardPushSubscribeRoute>('/v1/dashboard/push/subscribe', { schema: getRouteContract('POST', '/v1/dashboard/push/subscribe') }, async (request) => {
    const userId = getFastifySession(request)!.sub;
    addPushSubscription(userId, request.body);
    return { ok: true };
  });

  server.post<DashboardPushUnsubscribeRoute>('/v1/dashboard/push/unsubscribe', { schema: getRouteContract('POST', '/v1/dashboard/push/unsubscribe') }, async (request) => {
    const userId = getFastifySession(request)!.sub;
    const { endpoint } = request.body;
    removePushSubscription(userId, endpoint);
    return { ok: true };
  });

  server.post<DashboardPushTestRoute>('/v1/dashboard/push/test', { schema: getRouteContract('POST', '/v1/dashboard/push/test') }, async (request) => {
    await sendPushToUser(getFastifySession(request)!.sub, {
      title: 'dkrypt',
      body: 'Push notifications are set up - you\'ll get one of these when your queued decrypts finish.',
    });
    return { ok: true };
  });

  server.post<DashboardEmailTestRoute>('/v1/dashboard/email/test', { schema: getRouteContract('POST', '/v1/dashboard/email/test') }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    if (!resolveNotifyEmail(userId)) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'set a notification email first'));
    await sendMailToUser(userId, {
      subject: 'dkrypt',
      text: 'Email notifications are set up - you\'ll get one of these when your queued decrypts finish.',
    });
    return { ok: true };
  });

  server.put<DashboardPrefsUpdateRoute>('/v1/dashboard/me/prefs', { schema: getRouteContract('PUT', '/v1/dashboard/me/prefs') }, async (request) => {
    const body = request.body;
    const patch: Partial<UserPrefs> = {};
    if (body.theme) patch.theme = body.theme;
    if (body.density) patch.density = body.density;
    if (typeof body.accent === 'string' && /^[a-z-]{1,32}$/.test(body.accent)) patch.accent = body.accent;
    if (typeof body.sound === 'boolean') patch.sound = body.sound;
    if (typeof body.pushOnSuccess === 'boolean') patch.pushOnSuccess = body.pushOnSuccess;
    if (typeof body.pushOnFailure === 'boolean') patch.pushOnFailure = body.pushOnFailure;
    if (typeof body.pushOnAlerts === 'boolean') patch.pushOnAlerts = body.pushOnAlerts;
    if (typeof body.pushOnKeyExpiry === 'boolean') patch.pushOnKeyExpiry = body.pushOnKeyExpiry;
    if (typeof body.emailOnSuccess === 'boolean') patch.emailOnSuccess = body.emailOnSuccess;
    if (typeof body.emailOnFailure === 'boolean') patch.emailOnFailure = body.emailOnFailure;
    if (typeof body.emailOnAlerts === 'boolean') patch.emailOnAlerts = body.emailOnAlerts;
    if (typeof body.emailOnKeyExpiry === 'boolean') patch.emailOnKeyExpiry = body.emailOnKeyExpiry;
    if (typeof body.notifyEmail === 'string') {
      const trimmed = body.notifyEmail.trim();
      if (trimmed === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) patch.notifyEmail = trimmed;
    }
    if (typeof body.preferPrimaryDevice === 'boolean') patch.preferPrimaryDevice = body.preferPrimaryDevice;
    return updateUserPrefs(getFastifySession(request)!.sub, patch);
  });
};
