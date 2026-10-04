import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { dashboardDeviceParamsSchema } from '#dashboardDeviceContracts.js';
import { dashboardDeviceResponseSchema } from '#dashboardModelsContracts.js';
import { deviceTransportSchema, identifierSchema } from '#apiCommonContracts.js';

const deviceRecordProperties = {
  transport: Type.Optional(deviceTransportSchema),
  host: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  user: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  udid: Type.Optional(Type.String({ minLength: 8, maxLength: 80, pattern: '^[A-Za-z0-9-]+$' })),
  usbmuxNetwork: Type.Optional(Type.Boolean()),
  productType: Type.Optional(Type.String({ maxLength: 120 })),
  iosVersion: Type.Optional(Type.String({ maxLength: 64 })),
  toolchain: Type.Optional(Type.String({ maxLength: 120 })),
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
};

export const deviceConnectionInputSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  existingId: Type.Optional(identifierSchema),
  ...deviceRecordProperties,
}, { additionalProperties: true });

export const deviceRecordInputSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  ...deviceRecordProperties,
  enabled: Type.Optional(Type.Boolean()),
  isPrimary: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

export const devicePatchInputSchema = Type.Intersect([Type.Partial(deviceRecordInputSchema), Type.Object({ expectedUpdatedAt: Type.Optional(Type.Integer({ minimum: 0 })) })]);

export const deviceDiscoveryCandidateSchema = Type.Object({
  discoveryId: identifierSchema,
  name: Type.String(),
  transport: deviceTransportSchema,
  host: Type.Optional(Type.String()),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  user: Type.String(),
  udid: Type.Optional(Type.String()),
  usbmuxNetwork: Type.Optional(Type.Boolean()),
  productType: Type.Optional(Type.String()),
  productVersion: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal('usb'), Type.Literal('wifi')]),
}, { additionalProperties: true });

export const deviceDiscoveryResponseSchema = Type.Object({
  devices: Type.Array(deviceDiscoveryCandidateSchema),
  scannedNetworks: Type.Array(Type.String()),
  warnings: Type.Array(Type.String()),
}, { additionalProperties: true });

const deviceSetupInfoSchema = Type.Object({
  name: Type.String(),
  model: Type.Optional(Type.String()),
  productType: Type.Optional(Type.String()),
  productVersion: Type.Optional(Type.String()),
  architecture: Type.Optional(Type.String()),
  serialNumber: Type.Optional(Type.String()),
}, { additionalProperties: true });

const deviceSetupStepSchema = Type.Object({
  id: Type.String(),
  label: Type.String(),
  status: Type.Union([Type.Literal('ready'), Type.Literal('attention'), Type.Literal('unavailable')]),
  detail: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const deviceSetupResponseSchema = Type.Object({
  device: dashboardDeviceResponseSchema,
  setup: Type.Object({
    info: deviceSetupInfoSchema,
    steps: Type.Array(deviceSetupStepSchema),
    ready: Type.Boolean(),
  }, { additionalProperties: true }),
}, { additionalProperties: true });

export const deviceSetupOperationSchema = Type.Object({
  id: identifierSchema,
  status: Type.Union([Type.Literal('queued'), Type.Literal('running'), Type.Literal('interrupted'), Type.Literal('complete'), Type.Literal('failed')]),
  stage: Type.String(),
  stages: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), at: Type.Number(), status: Type.Union([Type.Literal('running'), Type.Literal('complete'), Type.Literal('failed')]) })),
  deviceId: Type.Optional(identifierSchema),
  ready: Type.Optional(Type.Boolean()),
  setup: Type.Optional(deviceSetupResponseSchema.properties.setup),
  error: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  completedAt: Type.Optional(Type.Number()),
});
export const deviceSetupOperationResponseSchema = Type.Object({ operation: deviceSetupOperationSchema });
export const deviceSetupOperationListResponseSchema = Type.Object({ operations: Type.Array(deviceSetupOperationSchema) });

export type DeviceConnectionInput = Static<typeof deviceConnectionInputSchema>;
export type DeviceRecordInput = Static<typeof deviceRecordInputSchema>;
export type DevicePatchInput = Static<typeof devicePatchInputSchema>;
export type DeviceDiscoveryResponse = Static<typeof deviceDiscoveryResponseSchema>;
export type DeviceSetupResponse = Static<typeof deviceSetupResponseSchema>;
export type DeviceManagementError = ApiErrorEnvelope;
export type DeviceRecordResponse = Static<typeof dashboardDeviceResponseSchema>;

export type DashboardDeviceDiscoveryRoute = {
  Reply: { 200: DeviceDiscoveryResponse; 401: DeviceManagementError; 403: DeviceManagementError; 502: DeviceManagementError };
};

export type DashboardDeviceSetupRoute = {
  Body: DeviceConnectionInput;
  Reply: { 201: DeviceSetupResponse; 400: DeviceManagementError; 401: DeviceManagementError; 403: DeviceManagementError; 404: DeviceManagementError; 502: DeviceManagementError };
};

export type DashboardDeviceCreateRoute = {
  Body: DeviceRecordInput;
  Reply: { 201: DeviceRecordResponse; 400: DeviceManagementError; 401: DeviceManagementError; 403: DeviceManagementError };
};

export type DashboardDeviceUpdateRoute = {
  Params: Static<typeof dashboardDeviceParamsSchema>;
  Body: DevicePatchInput;
  Reply: { 200: DeviceRecordResponse; 400: DeviceManagementError; 401: DeviceManagementError; 403: DeviceManagementError; 404: DeviceManagementError; 409: DeviceManagementError };
};

export type DashboardDeviceDeleteRoute = {
  Params: Static<typeof dashboardDeviceParamsSchema>;
  Reply: { 200: { ok: boolean }; 401: DeviceManagementError; 403: DeviceManagementError; 404: DeviceManagementError };
};
