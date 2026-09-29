import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardArtifactArchiveRoute, DashboardArtifactBulkArchiveRoute, DashboardArtifactBulkPinRoute, DashboardArtifactFileRoute, DashboardArtifactListRoute, DashboardArtifactPinRoute } from '#dashboardArtifactContracts.js';
import { artifactDownloadName, artifactFileAvailable, getArtifactById, listArtifacts, setArtifactArchived, setArtifactPinned, setArtifactsArchived, setArtifactsPinned, touchArtifact } from '#artifacts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { canAccessProject } from '#dashboardJobPresentation.js';
import { getRouteContract } from '#contracts.js';
import { streamFilePath } from '#jobs/http.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { DEFAULT_PROJECT_ID, recordAudit } from '#store/state.js';
import { Response } from '#http.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

interface DashboardArtifactServices {
  artifactDownloadName: typeof artifactDownloadName;
  artifactFileAvailable: typeof artifactFileAvailable;
  getArtifactById: typeof getArtifactById;
  listArtifacts: typeof listArtifacts;
  setArtifactPinned: typeof setArtifactPinned;
  setArtifactsPinned: typeof setArtifactsPinned;
  setArtifactArchived: typeof setArtifactArchived;
  setArtifactsArchived: typeof setArtifactsArchived;
  touchArtifact: typeof touchArtifact;
  canAccessProject: typeof canAccessProject;
  recordAudit: typeof recordAudit;
}

const defaultServices: DashboardArtifactServices = {
  artifactDownloadName,
  artifactFileAvailable,
  getArtifactById,
  listArtifacts,
  setArtifactPinned,
  setArtifactsPinned,
  setArtifactArchived,
  setArtifactsArchived,
  touchArtifact,
  canAccessProject,
  recordAudit,
};

const canRequestDecrypt = fastifyRequirePermission(PermissionFlag.requestDecrypt);
const canManageStorage = fastifyRequirePermission(PermissionFlag.manageAutomation);

export function createDashboardArtifactRoutes(overrides: Partial<DashboardArtifactServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardArtifactListRoute>('/v1/dashboard/artifacts', {
      schema: getRouteContract('GET', '/v1/dashboard/artifacts'),
      preHandler: canRequestDecrypt,
    }, (request, reply) => {
      const session = getFastifySession(request)!;
      const projectId = request.query.projectId ?? DEFAULT_PROJECT_ID;
      if (!services.canAccessProject(session.sub, session.permissions, projectId)) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'project not found');
      }
      const cursor = request.query.cursor;
      const result = services.listArtifacts({
        offset: cursor ? 0 : request.query.offset ?? 0,
        limit: request.query.limit ?? 50,
        cursor,
        query: request.query.q,
        channel: request.query.channel,
        archived: request.query.archived ?? false,
        projectIds: [projectId],
      });
      return {
        ...result,
        artifacts: result.artifacts.map((artifact) => ({
          ...artifact,
          filePath: undefined,
          fileUrl: `/v1/dashboard/artifacts/${encodeURIComponent(artifact.id)}/file`,
          createdAt: new Date(artifact.createdAt).toISOString(),
          lastAccessedAt: new Date(artifact.lastAccessedAt).toISOString(),
          pinnedAt: artifact.pinnedAt === undefined ? undefined : new Date(artifact.pinnedAt).toISOString(),
          archivedAt: artifact.archivedAt === undefined ? undefined : new Date(artifact.archivedAt).toISOString(),
        })),
        nextCursor: result.nextCursor,
      };
    });

    server.put<DashboardArtifactArchiveRoute>('/v1/dashboard/artifacts/:id/archive', {
      schema: getRouteContract('PUT', '/v1/dashboard/artifacts/:id/archive'),
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      const session = getFastifySession(request)!;
      const allowed = artifact?.projectIds.some((projectId) => services.canAccessProject(session.sub, session.permissions, projectId)) ?? false;
      if (!artifact || !services.artifactFileAvailable(artifact) || !allowed) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      const result = await services.setArtifactArchived(artifact.id, request.body.archived);
      if (!result.artifact) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      if (result.changed) services.recordAudit(session.sub, request.body.archived ? 'artifact.archive' : 'artifact.restore', artifact.id);
      return {
        ok: true,
        artifactId: artifact.id,
        archived: result.artifact.archivedAt !== undefined,
        archivedAt: result.artifact.archivedAt === undefined ? undefined : new Date(result.artifact.archivedAt).toISOString(),
      };
    });

    server.post<DashboardArtifactBulkArchiveRoute>('/v1/dashboard/artifacts/bulk-archive', {
      schema: getRouteContract('POST', '/v1/dashboard/artifacts/bulk-archive'),
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const artifacts = request.body.ids.map((id) => services.getArtifactById(id));
      const allAccessible = artifacts.every((artifact) => artifact
        && services.artifactFileAvailable(artifact)
        && artifact.projectIds.some((projectId) => services.canAccessProject(session.sub, session.permissions, projectId)));
      if (!allAccessible) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found');
      }

      const result = await services.setArtifactsArchived(request.body.ids, request.body.archived);
      if (result.missingIds.length > 0) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found');
      }
      for (const id of result.changedIds) {
        services.recordAudit(session.sub, request.body.archived ? 'artifact.archive' : 'artifact.restore', id);
      }
      return {
        ok: true,
        archived: request.body.archived,
        changedIds: result.changedIds,
        artifacts: result.artifacts.map((artifact) => ({
          artifactId: artifact.id,
          archived: artifact.archivedAt !== undefined,
          archivedAt: artifact.archivedAt === undefined ? undefined : new Date(artifact.archivedAt).toISOString(),
        })),
      };
    });

    server.put<DashboardArtifactPinRoute>('/v1/dashboard/artifacts/:id/pin', {
      schema: getRouteContract('PUT', '/v1/dashboard/artifacts/:id/pin'),
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      const session = getFastifySession(request)!;
      const allowed = artifact?.projectIds.some((projectId) => services.canAccessProject(session.sub, session.permissions, projectId)) ?? false;
      if (!artifact || !services.artifactFileAvailable(artifact) || !allowed) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      const result = await services.setArtifactPinned(artifact.id, request.body.pinned);
      if (!result.artifact) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      if (result.changed) services.recordAudit(session.sub, request.body.pinned ? 'artifact.pin' : 'artifact.unpin', artifact.id);
      return {
        ok: true,
        artifactId: artifact.id,
        pinned: result.artifact.pinnedAt !== undefined,
        pinnedAt: result.artifact.pinnedAt === undefined ? undefined : new Date(result.artifact.pinnedAt).toISOString(),
      };
    });

    server.post<DashboardArtifactBulkPinRoute>('/v1/dashboard/artifacts/bulk-pin', {
      schema: getRouteContract('POST', '/v1/dashboard/artifacts/bulk-pin'),
      preHandler: canManageStorage,
    }, async (request, reply) => {
      const session = getFastifySession(request)!;
      const artifacts = request.body.ids.map((id) => services.getArtifactById(id));
      const allAccessible = artifacts.every((artifact) => artifact
        && services.artifactFileAvailable(artifact)
        && artifact.projectIds.some((projectId) => services.canAccessProject(session.sub, session.permissions, projectId)));
      if (!allAccessible) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found');
      }

      const result = await services.setArtifactsPinned(request.body.ids, request.body.pinned);
      if (result.missingIds.length > 0) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'one or more artifacts were not found');
      }
      for (const id of result.changedIds) {
        services.recordAudit(session.sub, request.body.pinned ? 'artifact.pin' : 'artifact.unpin', id);
      }
      return {
        ok: true,
        pinned: request.body.pinned,
        changedIds: result.changedIds,
        artifacts: result.artifacts.map((artifact) => ({
          artifactId: artifact.id,
          pinned: artifact.pinnedAt !== undefined,
          pinnedAt: artifact.pinnedAt === undefined ? undefined : new Date(artifact.pinnedAt).toISOString(),
        })),
      };
    });

    server.get<DashboardArtifactFileRoute>('/v1/dashboard/artifacts/:id/file', {
      schema: getRouteContract('GET', '/v1/dashboard/artifacts/:id/file'),
      preHandler: canRequestDecrypt,
    }, async (request, reply) => {
      const artifact = services.getArtifactById(request.params.id);
      const session = getFastifySession(request)!;
      const allowed = artifact?.projectIds.some((projectId) => services.canAccessProject(session.sub, session.permissions, projectId)) ?? false;
      if (!artifact || !services.artifactFileAvailable(artifact) || !allowed) {
        reply.code(404);
        return createHttpErrorEnvelope(request.id, 404, 'artifact not found');
      }
      await services.touchArtifact(artifact);
      await streamFilePath(artifact.filePath, request.raw, new Response(reply), services.artifactDownloadName(artifact), artifact.fileSizeBytes, artifact.id);
      return;
    });
  };
}

export const dashboardArtifactRoutes = createDashboardArtifactRoutes();
