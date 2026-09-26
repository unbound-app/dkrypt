import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';

const diagnosticStatusSchema = Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('error')]);

export const dashboardDoctorResponseSchema = Type.Object({
  ok: Type.Boolean(),
  checkedAt: Type.String(),
  checks: Type.Array(Type.Object({ id: Type.String(), status: diagnosticStatusSchema, detail: Type.String() })),
});

export const dashboardSyntheticResponseSchema = Type.Object({
  ok: Type.Boolean(),
  checkedAt: Type.String(),
  probes: Type.Array(Type.Object({
    id: Type.Union([
      Type.Literal('database'),
      Type.Literal('artifacts'),
      Type.Literal('device-bridge'),
      Type.Literal('device-agent'),
      Type.Literal('testflight'),
      Type.Literal('webhooks'),
    ]),
    status: Type.Union([diagnosticStatusSchema, Type.Literal('skipped')]),
    durationMs: Type.Number({ minimum: 0 }),
    detail: Type.String(),
  })),
});

export type DashboardDoctorRoute = {
  Reply: { 200: Static<typeof dashboardDoctorResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardSyntheticRoute = {
  Reply: { 200: Static<typeof dashboardSyntheticResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};
