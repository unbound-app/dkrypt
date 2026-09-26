import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import type { DashboardManualDecryptPreflightRoute } from '#dashboardJobContracts.js';
import { projectIdentifierPattern } from '#apiCommonContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getDeviceHealth, getDeviceInstallBlocker, getDeviceReadiness } from '#deviceHealth.js';
import { getRouteContract } from '#contracts.js';
import { getActiveJobs } from '#jobs/store.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import {
  DEFAULT_PROJECT_ID,
  getAverageJobDurationMs,
  getDevice,
  getEffectiveDevices,
  getProject,
} from '#store/state.js';
import { getVerifiedTestFlightCatalog, TestFlightCatalogUnavailableError } from '#testflightSubscriptions.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

export interface DashboardDecryptPreflightServices {
  canAccessProject: typeof canAccessProject;
  getActiveJobs: typeof getActiveJobs;
  getAverageJobDurationMs: typeof getAverageJobDurationMs;
  getDevice: typeof getDevice;
  getDeviceHealth: typeof getDeviceHealth;
  getDeviceInstallBlocker: typeof getDeviceInstallBlocker;
  getDeviceReadiness: typeof getDeviceReadiness;
  getEffectiveDevices: typeof getEffectiveDevices;
  getProject: typeof getProject;
  getVerifiedTestFlightCatalog: typeof getVerifiedTestFlightCatalog;
}

const defaultServices: DashboardDecryptPreflightServices = {
  canAccessProject,
  getActiveJobs,
  getAverageJobDurationMs,
  getDevice,
  getDeviceHealth,
  getDeviceInstallBlocker,
  getDeviceReadiness,
  getEffectiveDevices,
  getProject,
  getVerifiedTestFlightCatalog,
};

const canRequestDecrypt = fastifyRequirePermission(PermissionFlag.requestDecrypt);

function sendPreflightError(requestId: string, reply: FastifyReply, statusCode: 400 | 404 | 409, message: string) {
  reply.code(statusCode);
  return createHttpErrorEnvelope(requestId, statusCode, message);
}

export function createDashboardDecryptPreflightRoutes(overrides: Partial<DashboardDecryptPreflightServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.post<DashboardManualDecryptPreflightRoute>('/v1/dashboard/decrypt/preflight', {
      schema: getRouteContract('POST', '/v1/dashboard/decrypt/preflight'),
      preHandler: canRequestDecrypt,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.body.projectId ?? DEFAULT_PROJECT_ID;
      if (!projectIdentifierPattern.test(projectId)) return sendPreflightError(request.id, reply, 400, 'projectId must be a valid project identifier');
      const project = services.getProject(projectId);
      if (!project || !services.canAccessProject(session.sub, session.permissions, projectId)) {
        return sendPreflightError(request.id, reply, 404, 'project not found');
      }
      if (project.archivedAt !== undefined) return sendPreflightError(request.id, reply, 409, 'project is archived');

      const bundleId = request.body.bundleId.trim();
      const testflight = request.body.testflight === true;
      const versionLabel = request.body.versionLabel?.trim().slice(0, 64) || undefined;
      const installSizeBytes = request.body.installSizeBytes;
      const requestedDeviceId = request.body.deviceId?.trim() ?? '';
      const requestedDevice = requestedDeviceId ? services.getDevice(requestedDeviceId) : undefined;
      if (requestedDeviceId && (!requestedDevice || !requestedDevice.enabled)) {
        return sendPreflightError(request.id, reply, 400, 'deviceId must refer to an enabled device');
      }

      let verifiedCatalog: Awaited<ReturnType<typeof getVerifiedTestFlightCatalog>> = [];
      if (testflight) {
        try {
          verifiedCatalog = await services.getVerifiedTestFlightCatalog({ requireAllDevices: true });
        } catch (error) {
          if (error instanceof TestFlightCatalogUnavailableError) {
            reply.code(503);
            return {
              error: error.message,
              code: 'testflight_catalog_unavailable',
              message: error.message,
              requestId: request.id,
              retryable: true,
            };
          }
          throw error;
        }
      }

      const verifiedTestFlightApp = testflight ? verifiedCatalog.find((entry) => entry.bundleId === bundleId) : undefined;
      if (testflight && !verifiedTestFlightApp) {
        return sendPreflightError(request.id, reply, 409, 'TestFlight access must be verified on an enabled device before queueing');
      }
      if (requestedDevice && verifiedTestFlightApp && !verifiedTestFlightApp.devices.some((device) => device.id === requestedDevice.id)) {
        return sendPreflightError(request.id, reply, 409, 'TestFlight access is not verified on the selected device');
      }

      const verifiedDeviceIds = verifiedTestFlightApp ? new Set(verifiedTestFlightApp.devices.map((device) => device.id)) : undefined;
      const devices = requestedDevice
        ? [requestedDevice]
        : services.getEffectiveDevices().filter((device) => device.enabled && (!verifiedDeviceIds || verifiedDeviceIds.has(device.id)));
      const primary = devices.find((device) => device.isPrimary) ?? devices[0];
      const checks = await Promise.all(devices.map(async (device) => {
        try {
          const health = await services.getDeviceHealth(device.id, true);
          const blockers: string[] = [];
          if (!health.reachable) blockers.push(health.error ?? 'device is unreachable');
          if (health.internetAccess === false) blockers.push('device cannot reach Apple services');
          const installBlocker = services.getDeviceInstallBlocker(health, installSizeBytes);
          if (installBlocker) blockers.push(installBlocker);
          if (health.readiness?.state === 'blocked') blockers.push(...(health.readiness.reasons.length > 0 ? health.readiness.reasons : ['device readiness is blocked']));
          if (testflight && health.testFlightBridgeReachable === false) blockers.push('TestFlight bridge is unresponsive');
          return {
            id: device.id,
            name: device.name,
            isPrimary: device.id === primary?.id,
            ready: blockers.length === 0,
            blockers: [...new Set(blockers)],
            readiness: health.readiness ?? services.getDeviceReadiness(health),
            reachable: health.reachable,
            storageFreeBytes: health.storageFreeBytes,
            batteryPercent: health.batteryPercent,
          };
        } catch (error) {
          return {
            id: device.id,
            name: device.name,
            isPrimary: device.id === primary?.id,
            ready: false,
            blockers: [error instanceof Error ? error.message : 'device health check failed'],
            reachable: false,
          };
        }
      }));

      return {
        bundleId,
        versionLabel,
        testflight,
        installSizeBytes,
        estimatedDurationMs: services.getAverageJobDurationMs(bundleId, projectId),
        queueLength: services.getActiveJobs().filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId).length,
        canQueue: checks.some((check) => check.ready),
        devices: checks,
      };
    });
  };
}

export const dashboardDecryptPreflightRoutes = createDashboardDecryptPreflightRoutes();
