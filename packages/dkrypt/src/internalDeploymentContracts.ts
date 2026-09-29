import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { deploymentMetadataSchema } from '#deploymentContracts.js';

export const deploymentReadyBodySchema = Type.Object({}, { additionalProperties: false });

export const deploymentReadyResponseSchema = Type.Object({
  ok: Type.Boolean(),
  created: Type.Integer({ minimum: 0 }),
  deployment: deploymentMetadataSchema,
});

export type DeploymentReadyRoute = {
  Body: Static<typeof deploymentReadyBodySchema>;
  Reply: { 200: Static<typeof deploymentReadyResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};
