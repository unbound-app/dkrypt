import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardProjectCreateRoute,
  DashboardProjectListRoute,
  DashboardProjectMembersRoute,
  DashboardProjectUpdateRoute,
} from '#dashboardProjectContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { dashboardEvents } from '#events.js';
import { canViewAllProjects } from '#dashboardJobPresentation.js';
import { getRouteContract } from '#contracts.js';
import { getAuthProfile } from '#identity.js';
import { PermissionFlag } from '#permissions.js';
import { applyWatchSchedules } from '#scheduler/index.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import {
  createProject,
  listAllowedUsers,
  listProjectsForUser,
  updateProject,
  type UpdateProjectInput,
} from '#store/state.js';
import { createHttpErrorEnvelope, sendHttpErrorEnvelope } from '#util/httpResponse.js';

export const dashboardProjectRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardProjectListRoute>('/v1/dashboard/projects', {
    schema: getRouteContract('GET', '/v1/dashboard/projects'),
  }, (request) => {
    const session = getFastifySession(request)!;
    const canViewAll = canViewAllProjects(session.permissions);
    const projects = listProjectsForUser(session.sub, canViewAll).map((project) => ({
      ...project,
      memberIds: canViewAll ? project.memberIds : undefined,
    }));
    return { projects };
  });

  server.get<DashboardProjectMembersRoute>('/v1/dashboard/projects/members', {
    schema: getRouteContract('GET', '/v1/dashboard/projects/members'),
    preHandler: fastifyRequirePermission(PermissionFlag.manageProjects),
  }, () => ({
    members: listAllowedUsers().map((user) => {
      const profile = getAuthProfile(user.username);
      return {
        id: user.username,
        username: profile?.username ?? user.username,
        displayName: profile?.displayName ?? user.username,
        avatarUrl: profile?.avatarUrl,
      };
    }),
  }));

  server.post<DashboardProjectCreateRoute>('/v1/dashboard/projects', {
    schema: getRouteContract('POST', '/v1/dashboard/projects'),
    attachValidation: true,
    preHandler: fastifyRequirePermission(PermissionFlag.manageProjects),
  }, (request, reply) => {
    if (request.validationError) {
      sendHttpErrorEnvelope(reply, request.id, 400, 'project name, description, members, or quotas are malformed');
      return;
    }
    const result = createProject(request.body, getFastifySession(request)!.sub);
    if (!result.ok || !result.project) {
      sendHttpErrorEnvelope(reply, request.id, 400, result.error ?? 'project creation was rejected');
      return;
    }
    reply.code(201).send(result.project);
    return;
  });

  server.patch<DashboardProjectUpdateRoute>('/v1/dashboard/projects/:id', {
    schema: getRouteContract('PATCH', '/v1/dashboard/projects/:id'),
    attachValidation: true,
    preHandler: fastifyRequirePermission(PermissionFlag.manageProjects),
  }, (request, reply) => {
    if (request.validationError) {
      sendHttpErrorEnvelope(reply, request.id, 400, 'project updates are malformed');
      return;
    }
    const supportedFields: Array<keyof UpdateProjectInput> = [
      'name',
      'description',
      'memberIds',
      'storageQuotaBytes',
      'dailyJobQuota',
      'maxConcurrentJobs',
      'archived',
    ];
    if (!supportedFields.some((field) => Object.hasOwn(request.body, field))) {
      sendHttpErrorEnvelope(reply, request.id, 400, 'no supported project fields were provided');
      return;
    }
    const result = updateProject(request.params.id, request.body, getFastifySession(request)!.sub);
    if (!result.ok || !result.project) {
      const statusCode = result.error === 'project not found' ? 404 : 400;
      reply.code(statusCode);
      return createHttpErrorEnvelope(request.id, statusCode, result.error ?? 'project update was rejected');
    }
    dashboardEvents.emit('projectChanged', request.params.id);
    applyWatchSchedules();
    return result.project;
  });
};
