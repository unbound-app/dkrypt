import { Type } from '@sinclair/typebox';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { getProject, recordAudit } from '#store/state.js';
import { createGithubOidcPolicy, createSignedTriggerPolicy, getSignedTriggerPolicy, listGithubOidcPolicies, listSignedTriggerPolicies, publicSignedTriggerPolicy, revokeGithubOidcPolicy, revokeSignedTriggerPolicy, rotateSignedTriggerSecret } from '#store/integrationRepository.js';

const bundleIdSchema = Type.String({ minLength: 3, maxLength: 200, pattern: '^[A-Za-z0-9.-]+$' });

export const dashboardIntegrationRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', fastifyRequirePermission(PermissionFlag.administrator));

  server.get('/v1/dashboard/integrations/signed-triggers', { schema: { hide: true } }, () => ({ integrations: listSignedTriggerPolicies() }));

  server.get('/v1/dashboard/integrations/github-oidc', { schema: { hide: true } }, () => ({ policies: listGithubOidcPolicies() }));

  server.post('/v1/dashboard/integrations/github-oidc', {
    schema: { hide: true, body: Type.Object({ repositoryId: Type.String({ pattern: '^[0-9]+$', maxLength: 32 }), workflowRef: Type.String({ minLength: 1, maxLength: 300 }), ref: Type.Optional(Type.String({ minLength: 1, maxLength: 250 })), environment: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), audience: Type.String({ minLength: 1, maxLength: 250 }), projectId: Type.String({ minLength: 1, maxLength: 80 }), bundleIds: Type.Array(bundleIdSchema, { minItems: 1, maxItems: 25, uniqueItems: true }), allowTestFlight: Type.Boolean() }, { additionalProperties: false }) },
  }, (request, reply) => {
    const input = request.body;
    if (Boolean(input.ref) === Boolean(input.environment) || [input.workflowRef, input.ref, input.environment, input.audience].some((value) => value?.includes('*'))) return reply.code(400).send(createHttpErrorEnvelope(request.id, 400, 'configure one exact ref or environment with no wildcards'));
    const project = getProject(input.projectId);
    if (!project || project.archivedAt) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'active project not found'));
    const policy = createGithubOidcPolicy({ ...input, createdBy: getFastifySession(request)!.sub });
    recordAudit(getFastifySession(request)!.sub, 'integration.create', policy.id, `${policy.projectId} · GitHub repository ${policy.repositoryId}`);
    return reply.code(201).send({ policy });
  });

  server.post('/v1/dashboard/integrations/github-oidc/:id/revoke', { schema: { hide: true, params: Type.Object({ id: Type.String() }) } }, (request, reply) => {
    if (!revokeGithubOidcPolicy(request.params.id)) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'active trust policy not found'));
    recordAudit(getFastifySession(request)!.sub, 'integration.revoke', request.params.id);
    return { ok: true };
  });

  server.post('/v1/dashboard/integrations/signed-triggers', {
    schema: { hide: true, body: Type.Object({ projectId: Type.String({ minLength: 1, maxLength: 80 }), bundleIds: Type.Array(bundleIdSchema, { minItems: 1, maxItems: 25, uniqueItems: true }), sources: Type.Array(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]), { minItems: 1, maxItems: 2, uniqueItems: true }) }, { additionalProperties: false }) },
  }, (request, reply) => {
    const project = getProject(request.body.projectId);
    if (!project || project.archivedAt) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'active project not found'));
    const policy = createSignedTriggerPolicy({ ...request.body, createdBy: getFastifySession(request)!.sub });
    recordAudit(getFastifySession(request)!.sub, 'integration.create', policy.id, `${policy.projectId} · ${policy.bundleIds.length} bundles`);
    return reply.code(201).send({ integration: publicSignedTriggerPolicy(policy), secret: policy.secret });
  });

  server.post('/v1/dashboard/integrations/signed-triggers/:id/rotate', { schema: { hide: true, params: Type.Object({ id: Type.String() }) } }, (request, reply) => {
    const policy = rotateSignedTriggerSecret(request.params.id);
    if (!policy) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'active integration not found'));
    recordAudit(getFastifySession(request)!.sub, 'integration.rotate', policy.id);
    return { integration: publicSignedTriggerPolicy(policy), secret: policy.secret };
  });

  server.post('/v1/dashboard/integrations/signed-triggers/:id/revoke', { schema: { hide: true, params: Type.Object({ id: Type.String() }) } }, (request, reply) => {
    const policy = getSignedTriggerPolicy(request.params.id);
    if (!policy || !revokeSignedTriggerPolicy(policy.id)) return reply.code(404).send(createHttpErrorEnvelope(request.id, 404, 'active integration not found'));
    recordAudit(getFastifySession(request)!.sub, 'integration.revoke', policy.id);
    return { integration: publicSignedTriggerPolicy(getSignedTriggerPolicy(policy.id)!) };
  });
};
