import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardArtifactFileRoute, DashboardArtifactListRoute, DashboardArtifactPinRoute } from '#dashboardArtifactContracts.js';
import { artifactDownloadName, artifactFileAvailable, getArtifactById, listArtifacts, setArtifactPinned, touchArtifact } from '#artifacts.js';
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
        })),
        nextCursor: result.nextCursor,
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
