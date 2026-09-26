import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardTestFlightBuildsRoute,
  DashboardTestFlightDecryptRoute,
  DashboardTestFlightDiagnosticsRoute,
  DashboardTestFlightTrainsRoute,
} from '#dashboardTestFlightContracts.js';
import { projectIdentifierPattern } from '#apiCommonContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { getRouteContract } from '#contracts.js';
import { fastifyBlockDuringMaintenance } from '#maintenance.js';
import { jobSummary } from '#jobs/http.js';
import { enqueueDecryptJob } from '#jobs/store.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { getTestFlightBridgeDiagnostics, listBuilds, listTrains, type TestFlightBridgeDiagnostics, type TFBuild, type TFTrain } from '#testflight.js';
import {
  DEFAULT_PROJECT_ID,
  getDevice,
  getPrimaryDevice,
  getProject,
  getUserPriority,
  type DeviceRecord,
} from '#store/state.js';
import { getVerifiedTestFlightCatalog, TestFlightCatalogUnavailableError, type TestFlightCatalogApp } from '#testflightSubscriptions.js';
import { externalRequestRateLimiter, fastifyRateLimitPerUser } from '#util/rateLimit.js';
import { scopedLogger } from '#logger.js';

interface TestFlightBrowseServices {
  listTrains: (appId: number, device?: DeviceRecord) => Promise<TFTrain[]>;
  listBuilds: (appId: number, trainVersion: string, device?: DeviceRecord) => Promise<TFBuild[]>;
  getDiagnostics: (device?: DeviceRecord) => Promise<TestFlightBridgeDiagnostics>;
  getVerifiedCatalog: (options: { requireAllDevices: boolean }) => Promise<TestFlightCatalogApp[]>;
  enqueueDecryptJob: typeof enqueueDecryptJob;
}

const defaultServices: TestFlightBrowseServices = {
  listTrains,
  listBuilds,
  getDiagnostics: getTestFlightBridgeDiagnostics,
  getVerifiedCatalog: getVerifiedTestFlightCatalog,
  enqueueDecryptJob,
};

const canDecrypt = fastifyRequirePermission(PermissionFlag.requestDecrypt);
const canManageSchedulerSettings = fastifyRequirePermission(PermissionFlag.manageAutomation);
const limitExternalRequest = fastifyRateLimitPerUser(
  externalRequestRateLimiter,
  (request) => getFastifySession(request)?.sub ?? request.ip,
  { code: 'rate_limited', retryable: true },
);
const log = scopedLogger('testflight');

function errorCode(statusCode: number): string {
  if (statusCode === 400) return 'request_error';
  if (statusCode === 401) return 'unauthorized';
  if (statusCode === 403) return 'forbidden';
  if (statusCode === 404) return 'not_found';
  if (statusCode === 409) return 'conflict';
  if (statusCode === 503) return 'service_unavailable';
  return 'request_error';
}

function parseTestFlightAppId(value: string): number | undefined {
  const appId = Number(value);
  return Number.isSafeInteger(appId) && appId > 0 ? appId : undefined;
}

function sendError(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  statusCode: number,
  message: string,
  code = errorCode(statusCode),
): void {
  const publicMessage = statusCode >= 500 && code !== 'testflight_catalog_unavailable'
    ? 'TestFlight service is temporarily unavailable'
    : message;
  reply.code(statusCode).send({
    error: publicMessage,
    message: publicMessage,
    code,
    requestId: request.id,
    retryable: statusCode >= 500,
  });
}

function sendUpstreamError(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  error: unknown,
  code: string,
): void {
  log.warn('dashboard TestFlight request failed', {
    requestId: request.id,
    error: error instanceof Error ? error.message : String(error),
  });
  sendError(request, reply, 502, 'TestFlight service is temporarily unavailable', code);
}

function resolveProjectId(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  rawProjectId: unknown,
): string | undefined {
  if (rawProjectId !== undefined && (typeof rawProjectId !== 'string' || !projectIdentifierPattern.test(rawProjectId))) {
    sendError(request, reply, 400, 'projectId must be a valid project identifier');
    return undefined;
  }
  const projectId = typeof rawProjectId === 'string' ? rawProjectId : DEFAULT_PROJECT_ID;
  const project = getProject(projectId);
  const session = getFastifySession(request);
  if (!project || !session || !canAccessProject(session.sub, session.permissions, projectId)) {
    sendError(request, reply, 404, 'project not found');
    return undefined;
  }
  if (project.archivedAt !== undefined) {
    sendError(request, reply, 409, 'project is archived');
    return undefined;
  }
  return projectId;
}

function resolveEnabledDevice(
  request: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  deviceId: string | undefined,
): DeviceRecord | undefined | null {
  if (!deviceId) return undefined;
  const device = getDevice(deviceId);
  if (!device || !device.enabled) {
    sendError(request, reply, 400, 'deviceId must refer to an enabled device');
    return null;
  }
  return device;
}

export function createDashboardTestFlightBrowseRoutes(overrides: Partial<TestFlightBrowseServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardTestFlightTrainsRoute>('/v1/dashboard/testflight/:appId/trains', {
      schema: getRouteContract('GET', '/v1/dashboard/testflight/:appId/trains'),
      preHandler: limitExternalRequest,
    }, async (request, reply) => {
      const appId = parseTestFlightAppId(request.params.appId);
      if (appId === undefined) {
        sendError(request, reply, 400, 'appId must be a positive integer');
        return reply;
      }
      const device = resolveEnabledDevice(request, reply, request.query.deviceId);
      if (device === null) return;
      try {
        return { trains: await services.listTrains(appId, device) };
      } catch (error) {
        sendUpstreamError(request, reply, error, 'testflight_lookup_failed');
        return reply;
      }
    });

    server.get<DashboardTestFlightDiagnosticsRoute>('/v1/dashboard/testflight/diagnostics', {
      schema: getRouteContract('GET', '/v1/dashboard/testflight/diagnostics'),
      preHandler: [canManageSchedulerSettings, limitExternalRequest],
    }, async (request, reply) => {
      try {
        return await services.getDiagnostics();
      } catch (error) {
        sendUpstreamError(request, reply, error, 'testflight_diagnostics_failed');
        return reply;
      }
    });

    server.get<DashboardTestFlightBuildsRoute>('/v1/dashboard/testflight/:appId/builds', {
      schema: getRouteContract('GET', '/v1/dashboard/testflight/:appId/builds'),
      preHandler: limitExternalRequest,
    }, async (request, reply) => {
      const appId = parseTestFlightAppId(request.params.appId);
      if (appId === undefined) {
        sendError(request, reply, 400, 'appId must be a positive integer');
        return reply;
      }
      const device = resolveEnabledDevice(request, reply, request.query.deviceId);
      if (device === null) return;
      try {
        return { builds: await services.listBuilds(appId, request.query.trainVersion, device) };
      } catch (error) {
        sendUpstreamError(request, reply, error, 'testflight_lookup_failed');
        return reply;
      }
    });

    server.post<DashboardTestFlightDecryptRoute>('/v1/dashboard/testflight/decrypt', {
      schema: getRouteContract('POST', '/v1/dashboard/testflight/decrypt'),
      preHandler: [canDecrypt, fastifyBlockDuringMaintenance],
    }, async (request, reply) => {
      const projectId = resolveProjectId(request, reply, request.body.projectId);
      if (!projectId) return;
      const bundleId = request.body.bundleId.trim();
      const appId = Number.parseInt(String(request.body.appId), 10);
      const build = request.body.build as TFBuild;
      if (!bundleId || !Number.isInteger(appId) || appId <= 0) {
        sendError(request, reply, 400, 'bundleId, appId, and build are required');
        return;
      }
      if (build.bundleId !== bundleId) {
        sendError(request, reply, 400, 'build.bundleId does not match bundleId');
        return;
      }

      const requestedDevice = resolveEnabledDevice(request, reply, request.body.deviceId?.trim());
      if (requestedDevice === null) return;
      let verifiedTestFlightApp: TestFlightCatalogApp | undefined;
      try {
        verifiedTestFlightApp = (await services.getVerifiedCatalog({ requireAllDevices: true }))
          .find((entry) => entry.appId === appId && entry.bundleId === bundleId);
      } catch (error) {
        if (error instanceof TestFlightCatalogUnavailableError) {
          sendError(request, reply, 503, error.message, 'testflight_catalog_unavailable');
          return;
        }
        throw error;
      }
      if (!verifiedTestFlightApp) {
        sendError(request, reply, 409, 'TestFlight access must be verified on an enabled device before queueing');
        return;
      }
      if (requestedDevice && !verifiedTestFlightApp.devices.some((device) => device.id === requestedDevice.id)) {
        sendError(request, reply, 409, 'TestFlight access is not verified on the selected device');
        return;
      }

      const primaryDeviceId = getPrimaryDevice()?.id;
      const preferredDeviceId = requestedDevice?.id
        ?? (request.body.preferPrimary && verifiedTestFlightApp.devices.some((device) => device.id === primaryDeviceId)
          ? primaryDeviceId
          : verifiedTestFlightApp.devices[0]?.id);
      const session = getFastifySession(request)!;
      const job = services.enqueueDecryptJob(
        bundleId,
        'manual',
        undefined,
        { appId, build },
        undefined,
        session.sub,
        getUserPriority(session.sub),
        preferredDeviceId,
        undefined,
        projectId,
      );
      reply.code(202);
      return jobSummary(job);
    });
  };
}

export const dashboardTestFlightBrowseRoutes = createDashboardTestFlightBrowseRoutes();
