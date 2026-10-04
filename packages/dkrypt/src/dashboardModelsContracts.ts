import { Type } from '@sinclair/typebox';
import { bundleIdSchema, deviceTransportSchema, identifierSchema, projectIdentifierSchema } from '#apiCommonContracts.js';
import { jobFailureClassSchema } from '#util/failureCategory.js';

export const deviceTransportStateSchema = Type.Union([
  Type.Literal('discovered'),
  Type.Literal('pairing'),
  Type.Literal('connecting'),
  Type.Literal('ready'),
  Type.Literal('degraded'),
  Type.Literal('recovering'),
  Type.Literal('offline'),
  Type.Literal('unsupported'),
]);

const bridgeHeartbeatSchema = Type.Object({
  bridgeVersion: Type.Optional(Type.String()),
  channel: Type.Optional(Type.Union([Type.Literal('springboard'), Type.Literal('testflight'), Type.Literal('appstore')])),
  process: Type.Optional(Type.String()),
  at: Type.Optional(Type.Number()),
}, { additionalProperties: true });

export const bridgeHeartbeatsSchema = Type.Object({
  springboard: Type.Optional(bridgeHeartbeatSchema),
  testflight: Type.Optional(bridgeHeartbeatSchema),
  appstore: Type.Optional(bridgeHeartbeatSchema),
}, { additionalProperties: true });

export const dashboardDeviceResponseSchema = Type.Object({
  id: identifierSchema,
  name: Type.String(),
  enabled: Type.Boolean(),
  draining: Type.Optional(Type.Boolean()),
  isPrimary: Type.Optional(Type.Boolean()),
  transport: deviceTransportSchema,
  host: Type.Optional(Type.String()),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  user: Type.Optional(Type.String()),
  udid: Type.Optional(Type.String()),
  usbmuxNetwork: Type.Optional(Type.Boolean()),
  productType: Type.Optional(Type.String()),
  iosVersion: Type.Optional(Type.String()),
  toolchain: Type.Optional(Type.String()),
  notes: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  setupRequired: Type.Boolean(),
  transportState: deviceTransportStateSchema,
  transportCapabilities: Type.Array(Type.String()),
  lastSeenAt: Type.Optional(Type.Number()),
  agentHeartbeatAt: Type.Optional(Type.Number()),
  bridgeHeartbeats: Type.Optional(bridgeHeartbeatsSchema),
  recoveryState: Type.Union([Type.Literal('stable'), Type.Literal('recovering'), Type.Literal('degraded'), Type.Literal('offline')]),
}, { additionalProperties: true });

export const schedulerSettingsResponseSchema = Type.Object({
  notifyWebhookUrl: Type.String(),
  notifyFormat: Type.Union([Type.Literal('embed'), Type.Literal('plain')]),
  notifySuccessMode: Type.Union([Type.Literal('instant'), Type.Literal('daily'), Type.Literal('weekly')]),
  notifyQuietHoursStart: Type.String(),
  notifyQuietHoursEnd: Type.String(),
  notifyOnKeyRequest: Type.Boolean(),
  notifyOnAutomationSuccess: Type.Boolean(),
  notifyOnAutomationFailure: Type.Boolean(),
  notifyOnKeyExpiringSoon: Type.Boolean(),
  notifyOnDeviceOffline: Type.Boolean(),
  notifyOnDeviceBatteryHot: Type.Boolean(),
  notifyOnDeviceBatteryLow: Type.Boolean(),
  notifyOnDiskFull: Type.Boolean(),
  notifyOnDeviceStorageLow: Type.Boolean(),
  notifyOnTestFlightBridgeDown: Type.Boolean(),
  notifyOnJobCompleted: Type.Boolean(),
  notifyOnQueueSloBreach: Type.Boolean(),
  schedulerRetryCount: Type.Integer({ minimum: 0 }),
  deviceOfflineAlertMinutes: Type.Integer({ minimum: 0 }),
  batteryHotAlertC: Type.Integer({ minimum: 0 }),
  batteryLowAlertPercent: Type.Integer({ minimum: 0 }),
  diskFullAlertPercent: Type.Integer({ minimum: 0 }),
  deviceStorageAlertPercent: Type.Integer({ minimum: 0 }),
  testFlightBridgeAlertMinutes: Type.Integer({ minimum: 0 }),
  jobHistoryRetentionDays: Type.Integer({ minimum: 0 }),
  maintenanceMode: Type.Boolean(),
}, { additionalProperties: true });

export const dashboardDispatchTargetSchema = Type.Object({
  repo: Type.String({ minLength: 3, maxLength: 200, pattern: '^[\\w.-]+/[\\w.-]+$' }),
  ghWorkflowFile: Type.String({ minLength: 1, maxLength: 200 }),
  mode: Type.Optional(Type.Union([Type.Literal('repository_dispatch'), Type.Literal('workflow_dispatch')])),
  ref: Type.Optional(Type.String({ maxLength: 200 })),
  inputs: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 100 }), Type.String({ maxLength: 500 }))),
}, { additionalProperties: true });

export const dashboardMaintenanceWindowSchema = Type.Object({
  start: Type.String({ pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }),
  end: Type.String({ pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }),
}, { additionalProperties: false });

export const dashboardWatchResponseSchema = Type.Object({
  id: identifierSchema,
  projectId: Type.Optional(projectIdentifierSchema),
  bundleId: bundleIdSchema,
  repo: Type.String(),
  ghWorkflowFile: Type.String(),
  dispatchTargets: Type.Optional(Type.Array(dashboardDispatchTargetSchema)),
  pollCron: Type.String(),
  timezone: Type.Optional(Type.String()),
  maintenanceWindow: Type.Optional(dashboardMaintenanceWindowSchema),
  missedRunPolicy: Type.Optional(Type.Union([Type.Literal('skip'), Type.Literal('runOnce')])),
  enabled: Type.Boolean(),
  webhookUrl: Type.Optional(Type.String()),
  testFlightPolicy: Type.Optional(Type.Union([Type.Literal('latest'), Type.Literal('latestNonExpired'), Type.Literal('train')])),
  testFlightTrain: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  nextRunAt: Type.Optional(Type.Number()),
  schedulable: Type.Optional(Type.Boolean()),
  configIssues: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: true });

const schedulerRunOutcomeSchema = Type.Object({
  ok: Type.Boolean(),
  triggered: Type.Boolean(),
  reason: Type.String(),
  failureClass: Type.Optional(jobFailureClassSchema),
  retryable: Type.Optional(Type.Boolean()),
  runUrl: Type.Optional(Type.String()),
  failureSummary: Type.Optional(Type.String()),
  destinationFailureSummary: Type.Optional(Type.String()),
  runStatus: Type.Optional(Type.Union([
    Type.Literal('dispatched'),
    Type.Literal('succeeded'),
    Type.Literal('failed'),
    Type.Literal('timed_out'),
  ])),
  observedVersion: Type.Optional(Type.String()),
  installMode: Type.Optional(Type.Union([Type.Literal('pinned'), Type.Literal('current')])),
  versionLabel: Type.Optional(Type.String()),
  dispatchTargetKeys: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: true });

export const dashboardSchedulerRunEntrySchema = Type.Object({
  id: identifierSchema,
  ts: Type.Number(),
  watchId: Type.Optional(identifierSchema),
  bundleId: Type.Optional(bundleIdSchema),
  appStore: schedulerRunOutcomeSchema,
  testflight: schedulerRunOutcomeSchema,
}, { additionalProperties: true });

export const dashboardMaintenanceStatusSchema = Type.Object({
  active: Type.Boolean(),
  manual: Type.Boolean(),
  auto: Type.Boolean(),
  reason: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const dashboardDiskUsageSchema = Type.Object({
  totalBytes: Type.Number(),
  freeBytes: Type.Number(),
  usedBytes: Type.Number(),
  usedPercent: Type.Number(),
}, { additionalProperties: true });
