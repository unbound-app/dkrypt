import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardEmailTestRoute, DashboardPrefsGetRoute, DashboardPrefsUpdateRoute, DashboardPushPublicKeyRoute, DashboardPushSubscribeRoute, DashboardPushTestRoute, DashboardPushUnsubscribeRoute } from '#dashboardAccountContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getRouteContract } from '#contracts.js';
import { getAuthProfile } from '#identity.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { resolveNotifyEmail, sendMailToUser } from '#mail.js';
import { getVapidPublicKey, sendPushToUser } from '#push.js';
import { fastifyRequireSession, getFastifySession } from '#session.js';
import { addPushSubscription, getUserPrefs, removePushSubscription, updateUserPrefs, type HomeLayoutPreference, type HomeModuleId, type UserPrefs } from '#store/state.js';

const homeModuleIds: HomeModuleId[] = ['artifacts', 'activeJobs', 'jobHistory'];
const defaultHomeLayout: HomeLayoutPreference = {
  id: 'default',
  name: 'Default',
  order: ['artifacts', 'activeJobs', 'jobHistory'],
  hidden: [],
  collapsed: [],
};

function normalizedPrefs(prefs: UserPrefs): UserPrefs {
  const defaults: UserPrefs = {
    density: 'comfortable',
    homeLayouts: [defaultHomeLayout],
    activeHomeLayoutId: defaultHomeLayout.id,
    viewModes: { artifacts: 'list', jobHistory: 'cards', devices: 'cards' },
    settingsMode: 'basic',
  };
  const homeLayouts = prefs.homeLayouts ?? [defaultHomeLayout];
  const activeHomeLayoutId = homeLayouts.some((layout) => layout.id === prefs.activeHomeLayoutId)
    ? prefs.activeHomeLayoutId
    : homeLayouts[0]?.id ?? defaultHomeLayout.id;
  return {
    ...defaults,
    ...prefs,
    homeLayouts,
    activeHomeLayoutId,
    viewModes: { artifacts: 'list', jobHistory: 'cards', devices: 'cards', ...prefs.viewModes },
  };
}

function validHomeLayouts(layouts: HomeLayoutPreference[]): boolean {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const layout of layouts) {
    const normalizedName = layout.name.trim().toLowerCase();
    if (ids.has(layout.id) || names.has(normalizedName) || normalizedName.length === 0) return false;
    ids.add(layout.id);
    names.add(normalizedName);
    if (layout.order.length !== homeModuleIds.length || homeModuleIds.some((moduleId) => !layout.order.includes(moduleId))) return false;
    if ([...layout.hidden, ...layout.collapsed].some((moduleId) => !layout.order.includes(moduleId))) return false;
    if (layout.hidden.some((moduleId) => layout.collapsed.includes(moduleId))) return false;
  }
  return true;
}

export const dashboardAccountRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardPrefsGetRoute>('/v1/dashboard/me/prefs', { schema: getRouteContract('GET', '/v1/dashboard/me/prefs') }, async (request) => {
    const userId = getFastifySession(request)!.sub;
    return { ...normalizedPrefs(getUserPrefs(userId)), accountEmail: getAuthProfile(userId)?.email };
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

  server.put<DashboardPrefsUpdateRoute>('/v1/dashboard/me/prefs', { schema: getRouteContract('PUT', '/v1/dashboard/me/prefs') }, async (request, reply) => {
    const body = request.body;
    const patch: Partial<UserPrefs> = {};
    if (body.formattingLocale) patch.formattingLocale = body.formattingLocale;
    if (body.interfaceLanguage) patch.interfaceLanguage = body.interfaceLanguage;
    if (body.theme) patch.theme = body.theme;
    if (body.density) patch.density = body.density;
    if (body.homeLayouts) patch.homeLayouts = body.homeLayouts.map((layout) => ({ ...layout, name: layout.name.trim() }));
    if (body.activeHomeLayoutId) patch.activeHomeLayoutId = body.activeHomeLayoutId;
    if (body.viewModes) patch.viewModes = { ...normalizedPrefs(getUserPrefs(getFastifySession(request)!.sub)).viewModes, ...body.viewModes };
    if (body.settingsMode) patch.settingsMode = body.settingsMode;
    if (typeof body.accent === 'string' && /^[a-z-]{1,32}$/.test(body.accent)) patch.accent = body.accent;
    if (typeof body.highContrast === 'boolean') patch.highContrast = body.highContrast;
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
    const userId = getFastifySession(request)!.sub;
    const current = normalizedPrefs(getUserPrefs(userId));
    const merged = { ...current, ...patch };
    if (merged.homeLayouts && !validHomeLayouts(merged.homeLayouts)) {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'Home layouts must use each available section exactly once and have unique names and IDs'));
    }
    if (merged.activeHomeLayoutId && !merged.homeLayouts?.some((layout) => layout.id === merged.activeHomeLayoutId)) {
      return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'activeHomeLayoutId must match a saved Home layout'));
    }
    if (body.homeLayouts && !body.activeHomeLayoutId && !body.homeLayouts.some((layout) => layout.id === current.activeHomeLayoutId)) {
      patch.activeHomeLayoutId = body.homeLayouts[0]?.id ?? defaultHomeLayout.id;
    }
    updateUserPrefs(userId, patch);
    return normalizedPrefs(getUserPrefs(userId));
  });
};
