import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { DashboardDoctorRoute, DashboardSyntheticRoute } from '#dashboardDiagnosticsContracts.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { getDeploymentMetadata } from '#deployment.js';
import { runConfigurationDoctor } from '#doctor.js';
import { PermissionFlag } from '#permissions.js';
import { fastifyRequirePermission, fastifyRequireSession } from '#session.js';
import { getRouteContract } from '#contracts.js';
import { runSyntheticProbes } from '#synthetic.js';

const canManageDevices = fastifyRequirePermission(PermissionFlag.manageDevices);

export const dashboardDiagnosticsRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.addHook('preHandler', fastifyRequireSession);
  server.addHook('preHandler', recordFastifyDashboardActivity);

  server.get<DashboardDoctorRoute>('/v1/dashboard/doctor', {
    schema: getRouteContract('GET', '/v1/dashboard/doctor'),
    preHandler: canManageDevices,
  }, async () => ({ ...await runConfigurationDoctor(), deployment: getDeploymentMetadata() }));

  server.get<DashboardSyntheticRoute>('/v1/dashboard/synthetic', {
    schema: getRouteContract('GET', '/v1/dashboard/synthetic'),
    preHandler: canManageDevices,
  }, async () => runSyntheticProbes());
};
