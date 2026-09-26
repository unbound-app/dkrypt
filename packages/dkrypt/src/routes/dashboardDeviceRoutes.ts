import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardDeviceActivityRoute,
  DashboardDeviceBatteryHistoryRoute,
  DashboardDeviceHealthHistoryRoute,
  DashboardDeviceListRoute,
  DashboardDeviceStorageHistoryRoute,
  DashboardDeviceTemperatureHistoryRoute,
} from '#dashboardDeviceContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { serializeDashboardDevice } from '#dashboardDevicePresentation.js';
import { getRouteContract } from '#contracts.js';
import { fastifyRequirePermission, fastifyRequireSession } from '#session.js';
import { PermissionFlag } from '#permissions.js';
import {
  getDevice,
  getDeviceActivityPage,
  getDeviceBatteryHourlyBuckets,
  getDeviceHealthHourlyBuckets,
  getDeviceStorageHourlyBuckets,
  getDeviceTemperatureHourlyBuckets,
  getDeviceUptimePercent,
  getEffectiveDevices,
  getPrimaryDevice,
} from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

const canViewDevices = fastifyRequirePermission(PermissionFlag.viewDevices, PermissionFlag.manageDevices);

function resolveDevice(id: string) {
  return getDevice(id) ?? (id === 'primary' ? getPrimaryDevice() : undefined);
}

export const dashboardDeviceRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardDeviceListRoute>('/v1/dashboard/devices', {
    schema: getRouteContract('GET', '/v1/dashboard/devices'),
    preHandler: canViewDevices,
  }, () => ({ devices: getEffectiveDevices().map(serializeDashboardDevice) }));

  server.get<DashboardDeviceActivityRoute>('/v1/dashboard/devices/:id/activity', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/activity'),
    preHandler: canViewDevices,
  }, (request, reply) => {
    const device = resolveDevice(request.params.id);
    if (!device) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'device not found'));
    const { cursor, limit, offset } = request.query;
    const page = getDeviceActivityPage(device.id, cursor ? 0 : offset ?? 0, Math.min(limit ?? 12, 50), cursor);
    return { activity: page.entries, total: page.total, nextCursor: page.nextCursor };
  });

  server.get<DashboardDeviceHealthHistoryRoute>('/v1/dashboard/devices/:id/health-history', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/health-history'),
    preHandler: canViewDevices,
  }, (request) => {
    const hours = request.query.hours ?? 24;
    return { buckets: getDeviceHealthHourlyBuckets(request.params.id, hours), uptimePercent: getDeviceUptimePercent(request.params.id, hours) ?? null };
  });

  server.get<DashboardDeviceBatteryHistoryRoute>('/v1/dashboard/devices/:id/battery-history', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/battery-history'),
    preHandler: canViewDevices,
  }, (request) => ({ buckets: getDeviceBatteryHourlyBuckets(request.params.id, request.query.hours ?? 24) }));

  server.get<DashboardDeviceTemperatureHistoryRoute>('/v1/dashboard/devices/:id/temperature-history', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/temperature-history'),
    preHandler: canViewDevices,
  }, (request) => ({ buckets: getDeviceTemperatureHourlyBuckets(request.params.id, request.query.hours ?? 24) }));

  server.get<DashboardDeviceStorageHistoryRoute>('/v1/dashboard/devices/:id/storage-history', {
    schema: getRouteContract('GET', '/v1/dashboard/devices/:id/storage-history'),
    preHandler: canViewDevices,
  }, (request) => ({ buckets: getDeviceStorageHourlyBuckets(request.params.id, request.query.hours ?? 24) }));
};
