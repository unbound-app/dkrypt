import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DeploymentReadyRoute } from '#internalDeploymentContracts.js';
import { getDeploymentMetadata } from '#deployment.js';
import { fastifyRequireApiKey } from '#auth.js';
import { getRouteContract } from '#contracts.js';
import { recordDeploymentReadyNotifications } from '#store/state.js';

export const internalDeploymentRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.post<DeploymentReadyRoute>('/v1/internal/deployment/ready', {
    schema: getRouteContract('POST', '/v1/internal/deployment/ready'),
    preHandler: fastifyRequireApiKey,
  }, () => {
    const deployment = getDeploymentMetadata();
    return { ok: true, created: recordDeploymentReadyNotifications(deployment), deployment };
  });
};
