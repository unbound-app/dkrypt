import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type { FastifySchema } from 'fastify';
import { bundleIdSchema as BundleId, deviceTransportSchema, identifierSchema, paginationQuerySchema } from '#apiCommonContracts.js';
import {
  authConnectionParamsSchema,
  authIdentifierParamsSchema,
  authLoginBodySchema,
  authOAuthCallbackQuerySchema,
  authPasskeyPayloadSchema,
  authPrivacyDeleteBodySchema,
  authProfileBodySchema,
  authReauthenticateBodySchema,
  authTokenBodySchema,
} from '#authContracts.js';
import {
  billingCheckoutBodySchema,
  billingIdempotencyKeyHeadersSchema,
  billingSubscriptionBodySchema,
  billingSubscriptionsQuerySchema,
  billingWebhookInboxParamsSchema,
  billingWebhookInboxQuerySchema,
  billingWebhookQuarantineBodySchema,
} from '#billingContracts.js';
import {
  dashboardOkResponseSchema,
  pushKeyResponseSchema,
  pushSubscriptionBodySchema,
  pushUnsubscribeBodySchema,
  userPrefsPatchBodySchema,
  userPrefsResponseSchema,
} from '#dashboardAccountContracts.js';
import {
  notificationListQuerySchema,
  notificationPageResponseSchema,
  notificationReadBodySchema,
  notificationReadResponseSchema,
} from '#dashboardNotificationContracts.js';
import { dashboardDeviceActivityQuerySchema, dashboardDeviceHistoryQuerySchema, dashboardDeviceParamsSchema } from '#dashboardDeviceContracts.js';
import {
  dashboardProjectCreateBodySchema as ProjectInput,
  dashboardProjectListResponseSchema as ProjectListResponse,
  dashboardProjectMembersResponseSchema as ProjectMembersResponse,
  dashboardProjectPatchBodySchema as ProjectPatchInput,
  dashboardProjectResponseSchema as ProjectResponse,
} from '#dashboardProjectContracts.js';
import {
  deviceConnectionInputSchema as DeviceConnectionInput,
  deviceDiscoveryResponseSchema as DeviceDiscoveryResponse,
  devicePatchInputSchema as DevicePatchInput,
  deviceRecordInputSchema as DeviceRecordInput,
  deviceSetupResponseSchema as DeviceSetupResponse,
} from '#dashboardDeviceManagementContracts.js';
import {
  deviceBridgeActionBodySchema as DeviceBridgeActionInput,
  deviceBridgeActionResponseSchema as DeviceBridgeActionResponse,
  deviceForceQuerySchema,
  deviceHealthResponseSchema as DeviceHealthResponse,
  deviceInventoryResponseSchema as DeviceInventoryResponse,
  devicePreflightResponseSchema as DevicePreflightResponse,
  deviceRecoveryResponseSchema as DeviceRecoveryResponse,
} from '#dashboardDeviceOperationContracts.js';
import { dashboardDoctorResponseSchema, dashboardSyntheticResponseSchema } from '#dashboardDiagnosticsContracts.js';
import { dashboardOverviewQuerySchema, dashboardOverviewResponseSchema } from '#dashboardOverviewContracts.js';
import {
  dashboardDeviceResponseSchema as DeviceResponse,
  dashboardDispatchTargetSchema as DispatchTargetInput,
  dashboardWatchResponseSchema as WatchResponse,
  bridgeHeartbeatsSchema,
  deviceTransportStateSchema as DeviceTransportState,
  schedulerSettingsResponseSchema as SchedulerSettingsResponse,
} from '#dashboardModelsContracts.js';
import { dashboardAuditLogQuerySchema, dashboardAuditLogResponseSchema, dashboardLogsQuerySchema, dashboardLogsResponseSchema } from '#dashboardObservabilityContracts.js';
import { dashboardJobHistoryPageSchema, dashboardJobListQuerySchema, dashboardJobParamsSchema, dashboardJobTimelineEventSchema } from '#dashboardJobContracts.js';
import {
  testFlightCatalogBundleParamsSchema,
  testFlightCatalogQuerySchema,
  testFlightCatalogResponseSchema,
  testFlightDeviceUnsubscribeResponseSchema,
  testFlightInviteBodySchema,
  testFlightSubscriptionConflictResponseSchema,
  testFlightSubscriptionMutationResponseSchema,
  testFlightSubscriptionPageSchema,
  testFlightSubscriptionParamsSchema,
} from '#dashboardTestFlightContracts.js';
import {
  backupDrillResponseSchema,
  backupExportResponseSchema,
  backupHistoryEntrySchema,
  backupHistoryParamsSchema,
  backupHistoryResponseSchema,
  backupImportBodySchema,
  backupOkResponseSchema,
  backupPreviewResponseSchema,
  backupSchedulePatchSchema,
  backupScheduleResponseSchema,
  backupSnapshotDrillResponseSchema,
} from '#dashboardBackupContracts.js';
import {
  dashboardArtifactRetentionPreviewResponseSchema as ArtifactQuotaRetentionPreviewResponse,
  dashboardArtifactRetentionQuerySchema,
  dashboardSettingsCronQuerySchema,
  dashboardSettingsPatchBodySchema,
  dashboardSettingsRetentionPreviewResponseSchema as RetentionPreviewResponse,
  dashboardSettingsRetentionQuerySchema,
  dashboardSettingsWebhookTestBodySchema,
  dashboardWebhookTestResponseSchema as TestWebhookResponse,
} from '#dashboardSettingsContracts.js';
import {
  dashboardRoleCreateBodySchema,
  dashboardRoleOkResponseSchema,
  dashboardRoleParamsSchema,
  dashboardRoleReorderBodySchema,
  dashboardRoleResponseSchema as RoleResponse,
  dashboardRolesResponseSchema as RolesResponse,
  dashboardRoleUpdateBodySchema,
} from '#dashboardRoleContracts.js';

const VersionSelector = Type.String({ minLength: 1, maxLength: 64, pattern: '^v?\\d+(?:\\.\\d+)*(?:_\\d+)?$' });
const Identifier = identifierSchema;
const JsonObject = Type.Object({}, { additionalProperties: true });
const JsonResponse = Type.Union([JsonObject, Type.Array(Type.Unknown()), Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const TestFlightAppId = Type.Union([
  Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }),
  Type.Integer({ minimum: 1 }),
]);
const TestFlightBuildInput = Type.Object(
  {
    id: Type.Integer({ minimum: 1 }),
    cfBundleShortVersion: Type.String({ minLength: 1, maxLength: 64 }),
    cfBundleVersion: Type.String({ minLength: 1, maxLength: 64 }),
    bundleId: BundleId,
    whatsNew: Type.Optional(Type.String({ maxLength: 5000 })),
    releaseDate: Type.Optional(Type.String({ maxLength: 64 })),
    expiration: Type.Optional(Type.String({ maxLength: 64 })),
    fileSize: Type.Optional(Type.Number({ minimum: 0 })),
  },
  { additionalProperties: true },
);
export const ErrorEnvelope = Type.Object(
  {
    error: Type.String(),
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    retryable: Type.Boolean(),
    remediation: Type.Optional(JsonObject),
  },
  { additionalProperties: true },
);
const PublicStatusState = Type.Union([
  Type.Literal('operational'),
  Type.Literal('degraded'),
  Type.Literal('maintenance'),
  Type.Literal('not_configured'),
  Type.Literal('paused'),
  Type.Literal('unknown'),
]);
const PublicStatusResponse = Type.Object({
  status: Type.Union([Type.Literal('operational'), Type.Literal('degraded'), Type.Literal('maintenance')]),
  checkedAt: Type.String(),
  components: Type.Object({
    service: Type.Object({ state: PublicStatusState }),
    automation: Type.Object({ state: PublicStatusState }),
    scheduler: Type.Object({ state: PublicStatusState }),
  }),
});
const PaginationQuery = paginationQuerySchema;
const ProviderEnvironment = Type.Union([Type.Literal('test'), Type.Literal('live')]);
const JobStatus = Type.Union([Type.Literal('queued'), Type.Literal('running'), Type.Literal('done'), Type.Literal('failed')]);
const JobFailureClass = Type.Union([
  Type.Literal('device_transport'),
  Type.Literal('app_store'),
  Type.Literal('testflight'),
  Type.Literal('network'),
  Type.Literal('storage'),
  Type.Literal('decrypt'),
  Type.Literal('cancelled'),
  Type.Literal('unknown'),
]);
const DeviceSubsystemState = Type.Union([Type.Literal('ready'), Type.Literal('degraded'), Type.Literal('offline'), Type.Literal('unsupported'), Type.Literal('unknown')]);
export const JobSummaryResponse = object({
  id: Identifier,
  correlationId: Identifier,
  projectId: Type.Optional(Identifier),
  bundleId: BundleId,
  externalVersionId: Type.Optional(Identifier),
  testflight: Type.Optional(object({ appId: Type.Number(), buildId: Type.Number(), version: Type.Optional(Type.String()), buildNumber: Type.Optional(Type.String()) })),
  versionLabel: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal('manual'), Type.Literal('scheduler')]),
  channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
  queuedBy: Type.Optional(Type.String()),
  priority: Type.Number(),
  deviceId: Type.Optional(Identifier),
  transport: Type.Optional(deviceTransportSchema),
  attempt: Type.Optional(Type.Number()),
  retryCount: Type.Optional(Type.Number()),
  deadlineAt: Type.Optional(Type.String()),
  deadlineExceeded: Type.Optional(Type.Boolean()),
  failureClass: Type.Optional(JobFailureClass),
  status: JobStatus,
  progress: Type.String(),
  warnings: Type.Optional(Type.Array(Type.String())),
  error: Type.Optional(Type.String()),
  artifactId: Type.Optional(Identifier),
  artifactUrl: Type.Optional(Type.String()),
  cacheHit: Type.Optional(Type.Boolean()),
  sizeBytes: Type.Optional(Type.Number()),
  sha256: Type.Optional(Type.String()),
  createdAt: Type.String(),
  startedAt: Type.Optional(Type.String()),
  finishedAt: Type.Optional(Type.String()),
  queue: Type.Optional(JsonObject),
  queueReason: Type.Optional(Type.String()),
  statusUrl: Type.String(),
});
const PageCursor = Type.Optional(Type.String());
const HealthResponse = object({
  ok: Type.Boolean(),
  serviceReady: Type.Boolean(),
  schedulerEnabled: Type.Boolean(),
  database: object({ path: Type.String(), schemaVersion: Type.Integer(), integrity: Type.Literal('ok') }),
  bridge: object({ state: Type.Union([Type.Literal('ready'), Type.Literal('offline')]), transport: Type.String(), deviceCount: Type.Integer(), capabilities: Type.Array(Type.String()) }),
  device: object({
    reachable: Type.Boolean(),
    bridgeReachable: Type.Boolean(),
    transport: Type.Optional(deviceTransportSchema),
    transportState: DeviceTransportState,
    capabilities: Type.Array(Type.String()),
    lastSeenAt: Type.Optional(Type.Number()),
    recoveryState: Type.Union([Type.Literal('stable'), Type.Literal('recovering'), Type.Literal('degraded'), Type.Literal('offline')]),
    readiness: Type.String(),
    subsystems: Type.Optional(object({
      usb: DeviceSubsystemState,
      mux: DeviceSubsystemState,
      agent: DeviceSubsystemState,
      appStore: DeviceSubsystemState,
      testFlight: DeviceSubsystemState,
      sshTunnel: DeviceSubsystemState,
      storage: DeviceSubsystemState,
      battery: DeviceSubsystemState,
      thermal: DeviceSubsystemState,
    })),
    bridgeHeartbeats: Type.Optional(bridgeHeartbeatsSchema),
  }),
});
const BillingProviderResponse = object({
  enabled: Type.Boolean(),
  environment: ProviderEnvironment,
  configured: Type.Optional(Type.Boolean()),
  ready: Type.Optional(Type.Boolean()),
  managedPayments: Type.Optional(Type.Boolean()),
  provider: Type.Optional(Type.Literal('nowpayments')),
  settlementCurrency: Type.Optional(Type.String()),
  assets: Type.Optional(Type.Array(Type.String())),
  missingConfiguration: Type.Optional(Type.Array(Type.String())),
  issues: Type.Optional(Type.Array(Type.String())),
});
const BillingResponse = object({
  enabled: Type.Boolean(),
  provider: Type.Union([Type.Literal('stripe'), Type.Literal('nowpayments'), Type.Literal('legacy')]),
  environment: ProviderEnvironment,
  managedPayments: Type.Boolean(),
  missingConfiguration: Type.Array(Type.String()),
  providers: object({ stripe: BillingProviderResponse, crypto: BillingProviderResponse }),
  plans: Type.Array(object({ id: Identifier, name: Type.String(), description: Type.String(), amount: Type.Number(), currency: Type.String(), priceId: Type.String() })),
  customerId: Type.Optional(Type.String()),
  customerEmail: Type.Optional(Type.String()),
  legacyBilling: Type.Boolean(),
  entitlement: JsonObject,
});
const BillingSubscriptionPage = object({ subscriptions: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const ArtifactPage = object({ artifacts: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), totalBytes: Type.Number(), maxBytes: Type.Number(), nextCursor: PageCursor });
const DeviceListResponse = object({ devices: Type.Array(DeviceResponse) });
export const JobTimelineResponse = object({
  id: Identifier,
  correlationId: Identifier,
  bundleId: BundleId,
  status: JobStatus,
  versionLabel: Type.Optional(Type.String()),
  deviceId: Type.Optional(Identifier),
  transport: Type.Optional(deviceTransportSchema),
  sizeBytes: Type.Optional(Type.Number()),
  warnings: Type.Optional(Type.Array(Type.String())),
  ipaMetadata: Type.Optional(JsonObject),
  ipaInfoPlist: Type.Optional(JsonObject),
  events: Type.Array(dashboardJobTimelineEventSchema),
  guidance: Type.Optional(JsonObject),
});
export type ApiErrorEnvelope = Static<typeof ErrorEnvelope>;
export type DashboardDeviceResponse = Static<typeof DeviceResponse>;
export type DashboardDeviceListResponse = Static<typeof DeviceListResponse>;
export type DashboardDeviceHealthHistoryResponse = Static<typeof DeviceHealthHistoryResponse>;
export type DashboardDeviceActivityResponse = Static<typeof DeviceActivityResponse>;
export type DashboardDeviceBatteryHistoryResponse = Static<typeof DeviceBatteryHistoryResponse>;
export type DashboardDeviceTemperatureHistoryResponse = Static<typeof DeviceTemperatureHistoryResponse>;
export type DashboardDeviceStorageHistoryResponse = Static<typeof DeviceStorageHistoryResponse>;
export type DashboardJobSummary = Static<typeof JobSummaryResponse>;
export type DashboardJobTimeline = Static<typeof JobTimelineResponse>;
export type DashboardJobHistoryPage = Static<typeof dashboardJobHistoryPageSchema>;
const SearchResponse = object({ results: Type.Array(JsonObject) });
const DashboardDecryptPreflightResponse = object({
  bundleId: BundleId,
  versionLabel: Type.Optional(Type.String()),
  testflight: Type.Boolean(),
  installSizeBytes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  estimatedDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  queueLength: Type.Integer({ minimum: 0 }),
  canQueue: Type.Boolean(),
  devices: Type.Array(object({
    id: Identifier,
    name: Type.String(),
    isPrimary: Type.Boolean(),
    ready: Type.Boolean(),
    blockers: Type.Array(Type.String()),
    readiness: Type.Optional(JsonObject),
    reachable: Type.Optional(Type.Boolean()),
    storageFreeBytes: Type.Optional(Type.Number({ minimum: 0 })),
    batteryPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  })),
});
const VersionsResponse = object({ versions: Type.Array(JsonObject) });
const AuthMfaResponse = object({ enabled: Type.Boolean(), recoveryCodesRemaining: Type.Integer({ minimum: 0 }) });
const AuthSessionResponse = object({
  loggedIn: Type.Boolean(),
  sub: Type.Optional(Identifier),
  displayName: Type.Optional(Type.String()),
  avatarUrl: Type.Optional(Type.String()),
  identities: Type.Array(JsonObject),
  linkedProviders: Type.Array(Type.String()),
  permissions: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.Integer()),
  githubOauthEnabled: Type.Boolean(),
  discordOauthEnabled: Type.Boolean(),
  publicBaseUrl: Type.String(),
  mfa: Type.Optional(object({ ...AuthMfaResponse.properties, required: Type.Boolean() })),
});
const AuthSessionListResponse = Type.Array(
  object({
    id: Identifier,
    sub: Identifier,
    createdAt: Type.Integer(),
    lastSeenAt: Type.Integer(),
    userAgent: Type.Optional(Type.String()),
    ip: Type.Optional(Type.String()),
    current: Type.Boolean(),
  }),
);
const BillingProviderStatusResponse = object({
  stripe: object({ enabled: Type.Boolean(), environment: ProviderEnvironment, missingConfiguration: Type.Array(Type.String()) }),
  crypto: object({
    enabled: Type.Boolean(),
    configured: Type.Boolean(),
    ready: Type.Boolean(),
    environment: ProviderEnvironment,
    settlementType: Type.String(),
    settlementCurrency: Type.String(),
    supportedChains: Type.Array(Type.String()),
    supportedAssets: Type.Array(Type.String()),
    missingConfiguration: Type.Array(Type.String()),
    issues: Type.Array(Type.String()),
    checkedAt: Type.Optional(Type.String()),
  }),
});
const WebhookInboxPage = object({ inbox: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const DeviceHealthHistoryResponse = object({
  buckets: Type.Array(object({ hourStart: Type.Number(), reachablePercent: Type.Union([Type.Number(), Type.Null()]) })),
  uptimePercent: Type.Union([Type.Number(), Type.Null()]),
});
const DeviceActivityResponse = object({
  activity: Type.Array(object({
    id: Identifier,
    ts: Type.Number(),
    deviceId: Identifier,
    kind: Type.Union([Type.Literal('health'), Type.Literal('bridge'), Type.Literal('job')]),
    message: Type.String(),
    bundleId: Type.Optional(BundleId),
  })),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: PageCursor,
});
const DeviceBatteryHistoryResponse = object({ buckets: Type.Array(object({ hourStart: Type.Number(), batteryPercent: Type.Union([Type.Number(), Type.Null()]) })) });
const DeviceTemperatureHistoryResponse = object({ buckets: Type.Array(object({ hourStart: Type.Number(), batteryTemperatureC: Type.Union([Type.Number(), Type.Null()]) })) });
const DeviceStorageHistoryResponse = object({ buckets: Type.Array(object({ hourStart: Type.Number(), storageUsedPercent: Type.Union([Type.Number(), Type.Null()]) })) });
const JobEtaResponse = object({ avgMs: Type.Union([Type.Number(), Type.Null()]) });
const JobSloResponse = object({ targetMs: Type.Number(), historicalP95Ms: Type.Union([Type.Number(), Type.Null()]), jobs: Type.Array(JsonObject) });
const DailyVolumeResponse = object({ days: Type.Array(object({ date: Type.String(), count: Type.Integer({ minimum: 0 }) })) });
const ArtifactSummaryResponse = object({
  id: Identifier,
  bundleId: BundleId,
  channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
  externalVersionId: Type.Optional(Identifier),
  testflightBuildId: Type.Optional(Type.Integer({ minimum: 1 })),
  versionLabel: Type.Optional(Type.String()),
  buildNumber: Type.Optional(Type.String()),
  sizeBytes: Type.Number({ minimum: 0 }),
  sha256: Type.String({ minLength: 64, maxLength: 64 }),
  createdAt: Type.String(),
  lastAccessedAt: Type.String(),
  accessCount: Type.Integer({ minimum: 0 }),
  fileUrl: Type.String(),
});
const ArtifactPinResponse = object({
  ok: Type.Boolean(),
  artifactId: Identifier,
  pinned: Type.Boolean(),
  pinnedAt: Type.Optional(Type.String({ format: 'date-time' })),
});
const ApiArtifactPage = object({
  artifacts: Type.Array(ArtifactSummaryResponse),
  total: Type.Integer({ minimum: 0 }),
  totalBytes: Type.Number({ minimum: 0 }),
  maxBytes: Type.Number({ minimum: 0 }),
  nextCursor: PageCursor,
});
const DashboardArtifactResponse = object({
  id: Identifier,
  key: Type.String(),
  bundleId: BundleId,
  channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
  externalVersionId: Type.Optional(Identifier),
  testflightBuildId: Type.Optional(Type.Integer({ minimum: 1 })),
  versionLabel: Type.Optional(Type.String()),
  buildNumber: Type.Optional(Type.String()),
  filePath: Type.Optional(Type.String()),
  fileSizeBytes: Type.Number({ minimum: 0 }),
  sha256: Type.String({ minLength: 64, maxLength: 64 }),
  createdAt: Type.String(),
  lastAccessedAt: Type.String(),
  accessCount: Type.Integer({ minimum: 0 }),
  pinnedAt: Type.Optional(Type.String({ format: 'date-time' })),
  sourceJobId: Type.Optional(Identifier),
  warnings: Type.Optional(Type.Array(Type.String())),
  fileUrl: Type.String(),
});
const DashboardArtifactPage = object({
  artifacts: Type.Array(DashboardArtifactResponse),
  total: Type.Integer({ minimum: 0 }),
  totalBytes: Type.Number({ minimum: 0 }),
  maxBytes: Type.Number({ minimum: 0 }),
  nextCursor: PageCursor,
});
const TestFlightTrainResponse = object({ trainVersion: Type.String(), buildCount: Type.Integer({ minimum: 0 }) });
const TestFlightBuildResponse = object({
  id: Type.Integer({ minimum: 1 }),
  cfBundleShortVersion: Type.String(),
  cfBundleVersion: Type.String(),
  bundleId: BundleId,
  whatsNew: Type.Optional(Type.String()),
  releaseDate: Type.Optional(Type.String()),
  expiration: Type.Optional(Type.String()),
  fileSize: Type.Optional(Type.Number({ minimum: 0 })),
});
const TestFlightTrainsResponse = object({ trains: Type.Array(TestFlightTrainResponse) });
const TestFlightBuildsResponse = object({ builds: Type.Array(TestFlightBuildResponse) });
const DecryptJobResponse = object({
  ...JobSummaryResponse.properties,
  selector: Type.Optional(Type.String()),
  resolvedVersion: Type.Optional(Type.String()),
  artifact: Type.Optional(ArtifactSummaryResponse),
});
const UserDirectoryResponse = object({
  users: Type.Array(object({
    username: Identifier,
    displayName: Type.String(),
    avatarUrl: Type.String(),
    roleIds: Type.Array(Identifier),
    addedAt: Type.Number(),
    lastActiveAt: Type.Optional(Type.Number()),
    priority: Type.Optional(Type.Number()),
    activity: Type.Optional(JsonObject),
  })),
});
const ApiKeyResponse = object({
  id: Identifier,
  name: Type.String(),
  ownerId: Identifier,
  status: Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('denied')]),
  createdAt: Type.Number(),
  approvedAt: Type.Optional(Type.Number()),
  lastUsedAt: Type.Optional(Type.Number()),
  expiresAt: Type.Optional(Type.Number()),
  hasUnrevealedSecret: Type.Optional(Type.Boolean()),
  lastUsedIp: Type.Optional(Type.String()),
  allowedBundleIds: Type.Optional(Type.Array(BundleId)),
  dailyLimit: Type.Optional(Type.Number()),
  maxConcurrent: Type.Optional(Type.Number()),
  allowTestFlight: Type.Optional(Type.Boolean()),
  priority: Type.Optional(Type.Number()),
  previousKeyValidUntil: Type.Optional(Type.Number()),
});
const ApiKeyCollectionResponse = object({ keys: Type.Array(ApiKeyResponse) });
const ApiKeyPageResponse = object({ keys: Type.Array(ApiKeyResponse), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const ApiKeyUsageResponse = object({ usage: Type.Array(object({ date: Type.String(), count: Type.Integer({ minimum: 0 }) })) });
const ApiKeyBundleUsageResponse = object({ bundles: Type.Array(object({ bundleId: BundleId, count: Type.Integer({ minimum: 0 }) })) });
const ApiKeyOutcomeResponse = object({ outcomes: Type.Array(JsonObject) });
const UrlResponse = object({ url: Type.String() });
const BillingCheckoutResponse = object({
  url: Type.String(),
  provider: Type.Optional(Type.Union([Type.Literal('stripe'), Type.Literal('nowpayments')])),
  checkoutId: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
});
const BillingCancelResponse = object({
  success: Type.Boolean(),
  status: Type.String(),
  provider: Type.Union([Type.Literal('stripe'), Type.Literal('nowpayments')]),
  idempotencyKey: Type.Optional(Type.String()),
  cancelAtPeriodEnd: Type.Optional(Type.Boolean()),
});
const BillingSubscriptionUpdateResponse = object({ success: Type.Boolean(), status: Type.String(), priceId: Type.Union([Type.String(), Type.Null()]) });
const OkResponse = dashboardOkResponseSchema;
const ApiKeySecretResponse = object({ id: Identifier, name: Type.String(), key: Type.String(), createdAt: Type.Number(), expiresAt: Type.Optional(Type.Number()) });
const ApiKeyRegenerateResponse = object({ ok: Type.Boolean(), key: Type.Optional(ApiKeyResponse) });
const AllowedUserResponse = object({
  username: Identifier,
  roleIds: Type.Array(Identifier),
  addedAt: Type.Number(),
  sessionVersion: Type.Optional(Type.Number()),
  lastActiveAt: Type.Optional(Type.Number()),
  priority: Type.Optional(Type.Number()),
});
const AuthTokenResponse = object({ ok: Type.Boolean(), expiresAt: Type.Optional(Type.Integer()) });
const AuthLoginResponse = object({ ok: Type.Boolean() });
const AuthRevokeOthersResponse = object({ ok: Type.Boolean(), revoked: Type.Integer({ minimum: 0 }) });
const PasskeySummaryResponse = object({
  id: Identifier,
  userId: Identifier,
  counter: Type.Integer({ minimum: 0 }),
  transports: Type.Optional(Type.Array(Type.String())),
  name: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  lastUsedAt: Type.Optional(Type.Number()),
});
const PasskeyListResponse = object({ passkeys: Type.Array(PasskeySummaryResponse) });
const PasskeyOptionsResponse = object({
  challenge: Type.String(),
  rp: Type.Optional(JsonObject),
  user: Type.Optional(JsonObject),
  rpId: Type.Optional(Type.String()),
  userVerification: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number({ minimum: 0 })),
  allowCredentials: Type.Optional(Type.Array(JsonObject)),
  excludeCredentials: Type.Optional(Type.Array(JsonObject)),
  pubKeyCredParams: Type.Optional(Type.Array(JsonObject)),
  attestation: Type.Optional(Type.String()),
  authenticatorSelection: Type.Optional(JsonObject),
});
const PasskeyMutationResponse = object({ passkey: Type.Optional(PasskeySummaryResponse) });
const AuthProfileResponse = object({ displayName: Type.String(), linkedProviders: Type.Array(Type.String()) });
const AuthConnectionResponse = object({ identities: Type.Array(JsonObject), linkedProviders: Type.Array(Type.String()) });
const WatchListResponse = object({ watches: Type.Array(WatchResponse) });
const WatchExportResponse = object({ version: Type.Integer({ minimum: 1 }), watches: Type.Array(JsonObject) });
const WatchHealthResponse = object({ watches: Type.Array(JsonObject) });
const WatchCalendarResponse = object({
  fromAt: Type.Number(),
  untilAt: Type.Number(),
  runs: Type.Array(object({ watchId: Identifier, bundleId: BundleId, at: Type.Number() })),
  truncated: Type.Boolean(),
});
const GitHubBudgetHistoryResponse = object({ entries: Type.Array(JsonObject) });
const GitHubReposResponse = object({ repos: Type.Array(JsonObject) });
const GitHubWorkflowsResponse = object({ workflows: Type.Array(JsonObject) });
const WatchImportResponse = object({ watches: Type.Array(WatchResponse), skipped: Type.Array(Type.String()) });
const DispatchPreviewResponse = object({ appStore: JsonObject, testflight: JsonObject });
const DispatchValidationResponse = object({ results: Type.Array(JsonObject), ok: Type.Boolean() });
const DispatchSourcePreviewResponse = object({ source: Type.Union([Type.Literal('appStore'), Type.Literal('testflight')]), result: JsonObject });
const AppMetadataResponse = object({ entries: Type.Array(JsonObject) });
const AppCatalogStatsResponse = object({ entries: Type.Integer({ minimum: 0 }), icons: Type.Integer({ minimum: 0 }), oldestUpdatedAt: Type.Optional(Type.Number()), newestUpdatedAt: Type.Optional(Type.Number()) });
const BundleStatsResponse = object({
  bundleId: BundleId,
  totalRuns: Type.Integer({ minimum: 0 }),
  doneCount: Type.Integer({ minimum: 0 }),
  failedCount: Type.Integer({ minimum: 0 }),
  successRate: Type.Number({ minimum: 0, maximum: 1 }),
  avgDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
  lastRunAt: Type.Optional(Type.Number()),
  failureBreakdown: Type.Array(object({ category: Type.String(), count: Type.Integer({ minimum: 0 }) })),
});
const BulkPreviewResponse = object({
  requested: Type.Integer({ minimum: 0 }),
  eligible: Type.Integer({ minimum: 0 }),
  projectedQueueAdds: Type.Integer({ minimum: 0 }),
  estimatedDurationMs: Type.Number({ minimum: 0 }),
  previousSizeBytes: Type.Number({ minimum: 0 }),
  items: Type.Array(JsonObject),
});
const JobDiffResponse = object({ a: JsonObject, b: JsonObject, sizeDeltaBytes: Type.Number(), plistDiff: Type.Array(JsonObject) });
const InsightsResponse = object({
  totalRuns: Type.Integer({ minimum: 0 }),
  doneCount: Type.Integer({ minimum: 0 }),
  failedCount: Type.Integer({ minimum: 0 }),
  successRate: Type.Number({ minimum: 0, maximum: 1 }),
  totalSizeBytes: Type.Number({ minimum: 0 }),
  manualCount: Type.Integer({ minimum: 0 }),
  schedulerCount: Type.Integer({ minimum: 0 }),
  topApps: Type.Array(JsonObject),
  trend: Type.Array(object({ date: Type.String(), count: Type.Integer({ minimum: 0 }) })),
  failureBreakdown: Type.Array(JsonObject),
  byDevice: Type.Array(JsonObject),
  anomalies: Type.Array(JsonObject),
});
const FailurePatternsResponse = object({ patterns: Type.Array(object({ message: Type.String(), count: Type.Integer({ minimum: 0 }), firstSeen: Type.Number(), lastSeen: Type.Number(), bundleIds: Type.Array(BundleId) })) });
const StorageForecastResponse = object({ freeBytes: Type.Number({ minimum: 0 }), bytesPerDay: Type.Number({ minimum: 0 }), daysRemaining: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]), sampleCount: Type.Integer({ minimum: 0 }) });
const JobExportResponse = Type.Union([Type.Array(JsonObject), Type.String()]);
const WebhookDeliveryPageResponse = object({ deliveries: Type.Array(JsonObject) });
const DiagnosticResponse = object({ generatedAt: Type.String(), correlationId: Identifier, job: JsonObject, timeline: Type.Array(JsonObject) });
const GitHubRateLimitResponse = object({
  limit: Type.Optional(Type.Integer({ minimum: 0 })),
  remaining: Type.Optional(Type.Integer({ minimum: 0 })),
  reset: Type.Optional(Type.Integer({ minimum: 0 })),
});
const SupportBundleResponse = object({
  generatedAt: Type.String(),
  deployment: object({ ref: Type.String(), node: Type.String() }),
  database: JsonObject,
  latestBackup: object({ ok: Type.Boolean(), detail: Type.String() }),
  disk: Type.Optional(JsonObject),
  catalog: JsonObject,
  devices: Type.Array(JsonObject),
  watches: Type.Array(JsonObject),
  watchHealth: JsonObject,
  schedulerRuns: Type.Array(JsonObject),
  logs: Type.Array(JsonObject),
  jobs: Type.Array(JsonObject),
});
const AuditExportResponse = Type.Union([Type.Array(JsonObject), Type.String()]);
const DiscordGuildResponse = object({ id: Identifier, name: Type.String(), icon: Type.Union([Type.String(), Type.Null()]) });
const DiscordStatusResponse = object({ botEnabled: Type.Boolean(), guilds: Type.Array(DiscordGuildResponse) });
const DiscordGuildsResponse = object({ guilds: Type.Array(DiscordGuildResponse) });
const DiscordRolesResponse = object({ roles: Type.Array(JsonObject) });
const DiscordPerksResponse = object({ perks: Type.Array(JsonObject) });
const DiscordGuildUpdateResponse = object({ ok: Type.Boolean(), guilds: Type.Array(DiscordGuildResponse) });
const DiscordRolePerkResponse = object({
  id: Identifier,
  guildId: Identifier,
  guildName: Type.Optional(Type.String()),
  guildIcon: Type.Union([Type.String(), Type.Null()]),
  discordRoleId: Identifier,
  discordRoleName: Type.Optional(Type.String()),
  discordRoleColor: Type.Integer(),
  appRoleId: Identifier,
  createdAt: Type.Number(),
});
const ApiKeyRevokedResponse = object({ revoked: Type.Array(Identifier) });
const ApiKeyExtendedResponse = object({ extended: Type.Array(Identifier) });
const ApiKeyUpdatedResponse = object({ updated: Type.Array(Identifier) });
const ApiKeyApprovedResponse = object({ approved: Type.Array(Identifier) });
const ApiKeyPriorityResponse = object({ ok: Type.Boolean(), priority: Type.Number() });
const ApiKeyConcurrencyResponse = object({ ok: Type.Boolean(), maxConcurrent: Type.Optional(Type.Union([Type.Number(), Type.Null()])) });
const ApiKeyTestFlightResponse = object({ ok: Type.Boolean(), allowTestFlight: Type.Boolean() });
const WebhookReceiptResponse = object({ received: Type.Boolean(), duplicate: Type.Optional(Type.Boolean()), quarantined: Type.Optional(Type.Boolean()), inProgress: Type.Optional(Type.Boolean()) });
const TestFlightDiagnosticsResponse = object({
  bridge: object({
    bridgeVersion: Type.Optional(Type.String()),
    capabilities: Type.Optional(Type.Array(Type.String())),
    hasInstaller: Type.Optional(Type.Boolean()),
    hasCatalogManager: Type.Optional(Type.Boolean()),
    backgroundTaskActive: Type.Optional(Type.Boolean()),
    backgroundTimeRemaining: Type.Optional(Type.Number()),
  }),
  install: Type.Optional(JsonObject),
  recentLog: Type.Optional(Type.Array(Type.String())),
});
const DispatchTriggerResponse = object({ ok: Type.Boolean(), error: Type.Optional(Type.String()) });
const BinaryFileResponse = { content: { 'application/octet-stream': { schema: Type.String({ format: 'binary' }) } } };
const EventStreamResponse = { content: { 'text/event-stream': { schema: Type.String() } } };
const PrometheusResponse = { content: { 'text/plain': { schema: Type.String() } } };
const WebhookReplayResponse = object({ replayed: Type.Boolean(), duplicate: Type.Optional(Type.Boolean()), status: Type.String() });
const WebhookQuarantineResponse = object({ record: Type.Optional(JsonObject) });
const WatchInput = object({
  projectId: Type.Optional(Identifier),
  bundleId: BundleId,
  repo: Type.Optional(Type.String({ minLength: 3, maxLength: 200, pattern: '^[\\w.-]+/[\\w.-]+$' })),
  ghWorkflowFile: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  dispatchTargets: Type.Optional(Type.Array(DispatchTargetInput, { maxItems: 10 })),
  pollCron: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  enabled: Type.Optional(Type.Boolean()),
  webhookUrl: Type.Optional(Type.String({ maxLength: 500 })),
  testFlightPolicy: Type.Optional(Type.Union([Type.Literal('latest'), Type.Literal('latestNonExpired'), Type.Literal('train')])),
  testFlightTrain: Type.Optional(Type.String({ maxLength: 100 })),
});

function object(properties: Record<string, TSchema>): TSchema {
  return Type.Object(properties, { additionalProperties: true });
}

const IdempotencyKeyHeaders = object({
  'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._:-]+$' })),
});
const contracts = new Map<string, FastifySchema>();

function register(method: string, path: string, schema: FastifySchema): void {
  const key = `${method} ${path}`;
  const previous = contracts.get(key);
  const customResponses = schema.response as Record<string, unknown> | undefined;
  const previousResponses = previous?.response as Record<string, unknown> | undefined;
  const inheritedResponses = { ...(previousResponses ?? {}) };
  if (inheritedResponses[200] === JsonResponse && customResponses) delete inheritedResponses[200];
  contracts.set(key, {
    ...previous,
    tags: schema.tags ?? previous?.tags ?? [path.startsWith('/v1/dashboard') ? 'dashboard' : 'public'],
    summary: schema.summary ?? previous?.summary ?? `${method} ${path}`,
    ...schema,
    response: {
      ...inheritedResponses,
      ...(customResponses ? {} : { 200: JsonResponse }),
      400: ErrorEnvelope,
      401: ErrorEnvelope,
      403: ErrorEnvelope,
      404: ErrorEnvelope,
      409: ErrorEnvelope,
      429: ErrorEnvelope,
      500: ErrorEnvelope,
      503: ErrorEnvelope,
      ...customResponses,
    },
  });
}

type ContractMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

const bodylessPostContracts = new Set([
  '/v1/auth/mfa/setup',
  '/v1/auth/refresh',
  '/v1/auth/logout',
  '/v1/auth/logout-everywhere',
  '/v1/auth/sessions/revoke-others',
  '/v1/dashboard/push/test',
  '/v1/dashboard/email/test',
  '/v1/dashboard/backup/history',
  '/v1/dashboard/backup/history/:id/drill',
]);

function registerGenericContract(method: ContractMethod, path: string): void {
  const parameterNames = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  const schema: FastifySchema = {};
  if (parameterNames.length > 0) {
    schema.params = Type.Object(Object.fromEntries(parameterNames.map((name) => [name, Identifier])), { additionalProperties: false });
  }
  if (method === 'GET') {
    schema.querystring = JsonObject;
  } else if (method !== 'DELETE' && !(method === 'POST' && bodylessPostContracts.has(path))) {
    schema.body = path.endsWith('/webhook') ? Type.Any() : JsonObject;
  }
  if (path.endsWith('/webhook')) {
    schema.headers = object({
      'stripe-signature': Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      'x-nowpayments-sig': Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    });
  }
  register(method, path, schema);
}

register('GET', '/v1/status', {
  tags: ['public'],
  summary: 'Public service status',
  response: { 200: PublicStatusResponse },
});

register('GET', '/v1/decrypt', {
  querystring: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), version: Type.Optional(VersionSelector), projectId: Type.Optional(Identifier) }),
});

register('POST', '/v1/testflight/decrypt', {
  body: object({ bundleId: BundleId, appId: TestFlightAppId, build: TestFlightBuildInput, projectId: Type.Optional(Identifier) }),
});

register('POST', '/v1/billing/checkout', {
  headers: billingIdempotencyKeyHeadersSchema,
  body: billingCheckoutBodySchema,
});

register('POST', '/v1/billing/cancel', { headers: billingIdempotencyKeyHeadersSchema });
register('GET', '/v1/billing', {});
register('POST', '/v1/billing/portal', {});
register('GET', '/v1/billing/provider-status', {});
register('GET', '/v1/billing/subscriptions', {
  querystring: billingSubscriptionsQuerySchema,
});

register('POST', '/v1/auth/login', { body: authLoginBodySchema });
register('POST', '/v1/auth/mfa/confirm', { body: authTokenBodySchema });
register('POST', '/v1/auth/mfa/verify', { body: authTokenBodySchema });
register('POST', '/v1/auth/mfa/disable', { body: authTokenBodySchema });
register('POST', '/v1/auth/mfa/recovery-codes', { body: authTokenBodySchema });
register('POST', '/v1/auth/reauthenticate', { body: authReauthenticateBodySchema });
register('POST', '/v1/auth/privacy/delete', { body: authPrivacyDeleteBodySchema });
register('GET', '/v1/auth/passkeys', {});
register('POST', '/v1/auth/passkeys/options', {});
register('POST', '/v1/auth/passkeys/verify', { body: authPasskeyPayloadSchema });
register('POST', '/v1/auth/passkeys/reauth/options', {});
register('POST', '/v1/auth/passkeys/reauth/verify', { body: authPasskeyPayloadSchema });
register('POST', '/v1/auth/passkeys/register/options', {});
register('POST', '/v1/auth/passkeys/register', { body: authPasskeyPayloadSchema });
register('DELETE', '/v1/auth/passkeys/:id', { params: authIdentifierParamsSchema });
register('GET', '/v1/artifacts', { querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }) });

register('POST', '/v1/dashboard/decrypt', {
  body: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), versionLabel: Type.Optional(Type.String({ maxLength: 64 })), preferPrimary: Type.Optional(Type.Boolean()), projectId: Type.Optional(Identifier) }),
});

register('POST', '/v1/dashboard/decrypt/preflight', {
  body: object({ bundleId: BundleId, testflight: Type.Optional(Type.Boolean()), versionLabel: Type.Optional(Type.String({ maxLength: 64 })), installSizeBytes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), deviceId: Type.Optional(Identifier), projectId: Type.Optional(Identifier) }),
});

register('POST', '/v1/dashboard/testflight/decrypt', {
  body: object({ bundleId: BundleId, appId: TestFlightAppId, build: TestFlightBuildInput, deviceId: Type.Optional(Identifier), preferPrimary: Type.Optional(Type.Boolean()), projectId: Type.Optional(Identifier) }),
});

register('GET', '/v1/jobs/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/artifacts/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/artifacts/:id/file', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/jobs/:id/status', { params: dashboardJobParamsSchema });
register('GET', '/v1/dashboard/jobs/:id/timeline', { params: dashboardJobParamsSchema });
register('GET', '/v1/dashboard/jobs/:id/diagnostic', { params: dashboardJobParamsSchema });
register('POST', '/v1/dashboard/jobs/:id/cancel', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/jobs/:id/prioritize', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/jobs/:id/retry', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/notifications', { querystring: notificationListQuerySchema });
register('GET', '/v1/dashboard/jobs', { querystring: dashboardJobListQuerySchema });
register('GET', '/v1/dashboard/artifacts', { querystring: object({ ...PaginationQuery.properties, projectId: Type.Optional(Identifier), q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }) });
register('PUT', '/v1/dashboard/artifacts/:id/pin', { params: object({ id: Identifier }), body: object({ pinned: Type.Boolean() }) });
register('GET', '/v1/dashboard/artifacts/retention-preview', { querystring: object({ maxBytes: Type.Integer({ minimum: 1 }) }) });
register('GET', '/v1/dashboard/logs', { querystring: dashboardLogsQuerySchema });
register('GET', '/v1/dashboard/audit-log', { querystring: dashboardAuditLogQuerySchema });
register('GET', '/v1/dashboard/keys/all', { querystring: object({ ...PaginationQuery.properties, search: Type.Optional(Type.String({ maxLength: 200 })) }) });
register('GET', '/v1/dashboard/webhooks', { querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }) });
register('GET', '/v1/dashboard/testflight/subscriptions', { querystring: PaginationQuery });
register('POST', '/v1/dashboard/testflight/subscriptions', { body: object({ url: Type.String({ minLength: 1, maxLength: 500 }) }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/approve', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/deny', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/sync', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/unsubscribe', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/testflight/catalog', { querystring: object({ refresh: Type.Optional(Type.Literal('true')) }) });

register('GET', '/v1/testflight/:appId/trains', { params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }), querystring: object({}) });
register('GET', '/v1/testflight/:appId/builds', { params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }), querystring: object({ trainVersion: Type.String({ minLength: 1, maxLength: 64 }) }) });

register('POST', '/v1/dashboard/devices/setup', { body: DeviceConnectionInput });
register('POST', '/v1/dashboard/devices', { body: DeviceRecordInput });
register('PATCH', '/v1/dashboard/devices/:id', { params: object({ id: Identifier }), body: DevicePatchInput });
register('DELETE', '/v1/dashboard/devices/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/health', { params: object({ id: Identifier }), querystring: deviceForceQuerySchema });
register('GET', '/v1/dashboard/devices/:id/preflight', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/inventory', { params: object({ id: Identifier }) });
register('PUT', '/v1/dashboard/devices/:id/dark-mode', { params: object({ id: Identifier }), body: object({ enabled: Type.Boolean() }) });
register('POST', '/v1/dashboard/devices/:id/bridge-action', { params: object({ id: Identifier }), body: DeviceBridgeActionInput });
register('POST', '/v1/dashboard/devices/:id/recover', { params: object({ id: Identifier }) });

register('POST', '/v1/billing/webhooks/inbox/:id/replay', { params: billingWebhookInboxParamsSchema });
register('POST', '/v1/billing/webhooks/inbox/:id/quarantine', { params: billingWebhookInboxParamsSchema, body: billingWebhookQuarantineBodySchema });
register('GET', '/v1/billing/webhooks/inbox', { querystring: billingWebhookInboxQuerySchema });

const remainingContracts: Array<[ContractMethod, string]> = [
  ['GET', '/v1/auth/session'],
  ['GET', '/v1/auth/mfa'],
  ['POST', '/v1/auth/mfa/setup'],
  ['GET', '/v1/auth/privacy/export'],
  ['PATCH', '/v1/auth/profile'],
  ['DELETE', '/v1/auth/connections/:provider'],
  ['POST', '/v1/auth/refresh'],
  ['POST', '/v1/auth/logout'],
  ['POST', '/v1/auth/logout-everywhere'],
  ['GET', '/v1/auth/sessions'],
  ['DELETE', '/v1/auth/sessions/:id'],
  ['POST', '/v1/auth/sessions/revoke-others'],
  ['GET', '/v1/auth/github/login'],
  ['GET', '/v1/auth/github/connect'],
  ['GET', '/v1/auth/github/callback'],
  ['GET', '/v1/auth/discord/login'],
  ['GET', '/v1/auth/discord/connect'],
  ['GET', '/v1/auth/discord/callback'],
  ['POST', '/v1/billing/subscription'],
  ['POST', '/v1/nowpayments/webhook'],
  ['POST', '/v1/stripe/webhook'],
  ['GET', '/v1/dashboard/overview'],
  ['GET', '/v1/dashboard/doctor'],
  ['GET', '/v1/dashboard/synthetic'],
  ['POST', '/v1/dashboard/notifications/read'],
  ['GET', '/v1/dashboard/events'],
  ['GET', '/v1/dashboard/artifacts/:id/file'],
  ['GET', '/v1/dashboard/artifacts/retention-preview'],
  ['GET', '/v1/dashboard/jobs/export'],
  ['GET', '/v1/dashboard/jobs/eta/:bundleId'],
  ['POST', '/v1/dashboard/jobs/bulk-preview'],
  ['GET', '/v1/dashboard/jobs/slo'],
  ['GET', '/v1/dashboard/jobs/stats/:bundleId'],
  ['GET', '/v1/dashboard/jobs/volume'],
  ['GET', '/v1/dashboard/jobs/diff'],
  ['GET', '/v1/dashboard/insights'],
  ['GET', '/v1/dashboard/failure-patterns'],
  ['GET', '/v1/dashboard/storage-forecast'],
  ['GET', '/v1/dashboard/support-bundle'],
  ['GET', '/v1/dashboard/search'],
  ['POST', '/v1/dashboard/testflight/catalog/:bundleId/unsubscribe'],
  ['GET', '/v1/dashboard/apps/metadata'],
  ['GET', '/v1/dashboard/apps/cache'],
  ['POST', '/v1/dashboard/apps/metadata/refresh'],
  ['GET', '/v1/dashboard/versions/:bundleId'],
  ['GET', '/v1/dashboard/devices/discover'],
  ['GET', '/v1/dashboard/github/rate-limit'],
  ['GET', '/v1/dashboard/watches'],
  ['GET', '/v1/dashboard/watches/export'],
  ['GET', '/v1/dashboard/watches/health'],
  ['GET', '/v1/dashboard/watches/calendar'],
  ['GET', '/v1/dashboard/github/budget-history'],
  ['GET', '/v1/dashboard/github/repos'],
  ['GET', '/v1/dashboard/github/workflows'],
  ['POST', '/v1/dashboard/watches'],
  ['PATCH', '/v1/dashboard/watches/:id'],
  ['DELETE', '/v1/dashboard/watches/:id'],
  ['POST', '/v1/dashboard/watches/import'],
  ['POST', '/v1/dashboard/watches/preview-dispatch-draft'],
  ['POST', '/v1/dashboard/watches/validate-dispatch-draft'],
  ['GET', '/v1/dashboard/watches/:id/preview-dispatch'],
  ['GET', '/v1/dashboard/watches/:id/preview-dispatch/:source'],
  ['POST', '/v1/dashboard/watches/:id/trigger-dispatch'],
  ['GET', '/v1/dashboard/testflight/:appId/trains'],
  ['GET', '/v1/dashboard/testflight/diagnostics'],
  ['GET', '/v1/dashboard/testflight/:appId/builds'],
  ['POST', '/v1/dashboard/jobs/reorder'],
  ['GET', '/v1/dashboard/keys/mine'],
  ['POST', '/v1/dashboard/keys/request'],
  ['POST', '/v1/dashboard/keys/create'],
  ['POST', '/v1/dashboard/keys/:id/reveal'],
  ['POST', '/v1/dashboard/keys/:id/regenerate'],
  ['DELETE', '/v1/dashboard/keys/:id'],
  ['POST', '/v1/dashboard/keys/bulk-revoke'],
  ['POST', '/v1/dashboard/keys/bulk-extend-expiry'],
  ['POST', '/v1/dashboard/keys/bulk-set-daily-limit'],
  ['POST', '/v1/dashboard/keys/bulk-set-scope'],
  ['GET', '/v1/dashboard/keys/:id/usage'],
  ['GET', '/v1/dashboard/keys/:id/bundle-usage'],
  ['GET', '/v1/dashboard/keys/:id/outcomes'],
  ['GET', '/v1/dashboard/keys/pending'],
  ['POST', '/v1/dashboard/keys/:id/approve'],
  ['POST', '/v1/dashboard/keys/bulk-approve'],
  ['PATCH', '/v1/dashboard/keys/:id/priority'],
  ['PATCH', '/v1/dashboard/keys/:id/max-concurrent'],
  ['PATCH', '/v1/dashboard/keys/:id/allow-testflight'],
  ['POST', '/v1/dashboard/keys/:id/deny'],
  ['GET', '/v1/dashboard/settings'],
  ['PUT', '/v1/dashboard/settings'],
  ['GET', '/v1/dashboard/settings/job-history-retention/preview'],
  ['GET', '/v1/dashboard/settings/validate-cron'],
  ['POST', '/v1/dashboard/settings/test-webhook'],
  ['GET', '/v1/dashboard/users'],
  ['GET', '/v1/dashboard/audit-log/export'],
  ['GET', '/v1/dashboard/roles'],
  ['GET', '/v1/dashboard/projects'],
  ['GET', '/v1/dashboard/projects/members'],
  ['POST', '/v1/dashboard/projects'],
  ['PATCH', '/v1/dashboard/projects/:id'],
  ['POST', '/v1/dashboard/roles'],
  ['PATCH', '/v1/dashboard/roles/:id'],
  ['DELETE', '/v1/dashboard/roles/:id'],
  ['POST', '/v1/dashboard/roles/reorder'],
  ['GET', '/v1/dashboard/discord/status'],
  ['GET', '/v1/dashboard/discord/guilds'],
  ['POST', '/v1/dashboard/discord/guilds'],
  ['GET', '/v1/dashboard/discord/roles'],
  ['GET', '/v1/dashboard/discord/perks'],
  ['POST', '/v1/dashboard/discord/perks'],
  ['DELETE', '/v1/dashboard/discord/perks/:id'],
  ['POST', '/v1/dashboard/users'],
  ['PATCH', '/v1/dashboard/users/:username'],
  ['DELETE', '/v1/dashboard/users/:username'],
  ['GET', '/v1/dashboard/backup/export'],
  ['POST', '/v1/dashboard/backup/import'],
  ['POST', '/v1/dashboard/backup/preview'],
  ['POST', '/v1/dashboard/backup/drill'],
  ['GET', '/v1/dashboard/backup/schedule'],
  ['POST', '/v1/dashboard/backup/schedule'],
  ['GET', '/v1/dashboard/backup/history'],
  ['POST', '/v1/dashboard/backup/history'],
  ['GET', '/v1/dashboard/backup/history/:id/download'],
  ['POST', '/v1/dashboard/backup/history/:id/drill'],
  ['DELETE', '/v1/dashboard/backup/history/:id'],
  ['GET', '/v1/dashboard/me/prefs'],
  ['GET', '/v1/dashboard/push/public-key'],
  ['POST', '/v1/dashboard/push/subscribe'],
  ['POST', '/v1/dashboard/push/unsubscribe'],
  ['POST', '/v1/dashboard/push/test'],
  ['POST', '/v1/dashboard/email/test'],
  ['PUT', '/v1/dashboard/me/prefs'],
  ['GET', '/v1/health'],
  ['GET', '/v1/metrics'],
];

for (const [method, path] of remainingContracts) registerGenericContract(method, path);

register('PATCH', '/v1/auth/profile', { body: authProfileBodySchema });
register('DELETE', '/v1/auth/connections/:provider', { params: authConnectionParamsSchema });
register('GET', '/v1/auth/github/callback', { querystring: authOAuthCallbackQuerySchema });
register('GET', '/v1/auth/discord/callback', { querystring: authOAuthCallbackQuerySchema });
register('POST', '/v1/dashboard/notifications/read', { body: notificationReadBodySchema });
register('POST', '/v1/dashboard/jobs/bulk-preview', { body: object({ ids: Type.Array(Identifier, { maxItems: 100 }), projectId: Type.Optional(Identifier) }) });
register('POST', '/v1/dashboard/jobs/reorder', { body: object({ ids: Type.Array(Identifier, { maxItems: 100 }), projectId: Type.Optional(Identifier) }) });
register('POST', '/v1/stripe/webhook', { headers: object({ 'stripe-signature': Type.String({ minLength: 1, maxLength: 200 }) }), body: Type.Any() });
register('POST', '/v1/nowpayments/webhook', { headers: object({ 'x-nowpayments-sig': Type.String({ minLength: 1, maxLength: 500 }) }), body: Type.Any() });

register('GET', '/v1/health', { response: { 200: HealthResponse } });
register('GET', '/v1/billing', { response: { 200: BillingResponse } });
register('GET', '/v1/billing/subscriptions', { response: { 200: BillingSubscriptionPage } });
register('GET', '/v1/dashboard/overview', { querystring: dashboardOverviewQuerySchema, response: { 200: dashboardOverviewResponseSchema } });
register('GET', '/v1/dashboard/jobs', { response: { 200: dashboardJobHistoryPageSchema, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/artifacts', { response: { 200: ArtifactPage } });
register('GET', '/v1/dashboard/devices', { response: { 200: DeviceListResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/health', { params: object({ id: Identifier }), querystring: deviceForceQuerySchema, response: { 200: DeviceHealthResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/preflight', { params: object({ id: Identifier }), response: { 200: DevicePreflightResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/inventory', { params: object({ id: Identifier }), response: { 200: DeviceInventoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('PUT', '/v1/dashboard/devices/:id/dark-mode', { params: object({ id: Identifier }), body: object({ enabled: Type.Boolean() }), response: { 200: DeviceHealthResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('POST', '/v1/dashboard/devices/:id/bridge-action', { params: object({ id: Identifier }), body: DeviceBridgeActionInput, response: { 200: DeviceBridgeActionResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('POST', '/v1/dashboard/devices/:id/recover', { params: object({ id: Identifier }), response: { 200: DeviceRecoveryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope } });
register('GET', '/v1/dashboard/jobs/:id/status', { params: dashboardJobParamsSchema, response: { 200: JobSummaryResponse, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/jobs/:id/timeline', { params: dashboardJobParamsSchema, response: { 200: JobTimelineResponse, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/testflight/catalog', { querystring: testFlightCatalogQuerySchema, response: { 200: testFlightCatalogResponseSchema } });
register('GET', '/v1/auth/session', { response: { 200: AuthSessionResponse } });
register('GET', '/v1/auth/mfa', { response: { 200: AuthMfaResponse } });
register('POST', '/v1/auth/mfa/setup', { response: { 200: object({ secret: Type.String(), otpauthUrl: Type.String() }) } });
register('POST', '/v1/auth/mfa/confirm', { response: { 200: object({ enabled: Type.Boolean(), recoveryCodes: Type.Array(Type.String()) }) } });
register('POST', '/v1/auth/mfa/disable', { response: { 200: object({ enabled: Type.Boolean(), recoveryCodesRemaining: Type.Integer({ minimum: 0 }) }) } });
register('POST', '/v1/auth/mfa/recovery-codes', { response: { 200: object({ recoveryCodes: Type.Array(Type.String()) }) } });
register('POST', '/v1/auth/mfa/verify', { response: { 200: AuthTokenResponse } });
register('POST', '/v1/auth/reauthenticate', { response: { 200: AuthTokenResponse } });
register('GET', '/v1/auth/sessions', { response: { 200: AuthSessionListResponse } });
register('DELETE', '/v1/auth/sessions/:id', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/auth/sessions/revoke-others', { response: { 200: AuthRevokeOthersResponse } });
register('GET', '/v1/billing/provider-status', { response: { 200: BillingProviderStatusResponse } });
register('GET', '/v1/billing/webhooks/inbox', { response: { 200: WebhookInboxPage } });
register('GET', '/v1/dashboard/doctor', { response: { 200: dashboardDoctorResponseSchema } });
register('GET', '/v1/dashboard/synthetic', { response: { 200: dashboardSyntheticResponseSchema } });
register('GET', '/v1/dashboard/notifications', { response: { 200: notificationPageResponseSchema } });
register('GET', '/v1/dashboard/devices/discover', { response: { 200: DeviceDiscoveryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 502: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/health-history', { params: dashboardDeviceParamsSchema, querystring: dashboardDeviceHistoryQuerySchema, response: { 200: DeviceHealthHistoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/activity', { params: dashboardDeviceParamsSchema, querystring: dashboardDeviceActivityQuerySchema, response: { 200: DeviceActivityResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/battery-history', { params: dashboardDeviceParamsSchema, querystring: dashboardDeviceHistoryQuerySchema, response: { 200: DeviceBatteryHistoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/temperature-history', { params: dashboardDeviceParamsSchema, querystring: dashboardDeviceHistoryQuerySchema, response: { 200: DeviceTemperatureHistoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/devices/:id/storage-history', { params: dashboardDeviceParamsSchema, querystring: dashboardDeviceHistoryQuerySchema, response: { 200: DeviceStorageHistoryResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/jobs/eta/:bundleId', { params: object({ bundleId: BundleId }), response: { 200: JobEtaResponse } });
register('GET', '/v1/dashboard/jobs/slo', { response: { 200: JobSloResponse } });
register('GET', '/v1/dashboard/jobs/volume', { response: { 200: DailyVolumeResponse } });
register('GET', '/v1/dashboard/webhooks', { response: { 200: object({ deliveries: Type.Array(JsonObject) }) } });
register('GET', '/v1/auth/privacy/export', { response: { 200: Type.String() } });
register('POST', '/v1/auth/privacy/delete', { response: { 200: OkResponse } });
register('PATCH', '/v1/auth/profile', { response: { 200: AuthProfileResponse } });
register('DELETE', '/v1/auth/connections/:provider', {
  params: object({ provider: Type.Union([Type.Literal('github'), Type.Literal('discord')]) }),
  response: { 200: AuthConnectionResponse },
});
register('POST', '/v1/auth/refresh', { response: { 200: AuthTokenResponse } });
register('POST', '/v1/auth/login', { response: { 200: AuthLoginResponse } });
register('POST', '/v1/auth/logout', { response: { 200: OkResponse } });
register('POST', '/v1/auth/logout-everywhere', { response: { 200: OkResponse } });
register('GET', '/v1/auth/passkeys', { response: { 200: PasskeyListResponse } });
register('POST', '/v1/auth/passkeys/register/options', { response: { 200: PasskeyOptionsResponse } });
register('POST', '/v1/auth/passkeys/register', { response: { 201: PasskeyMutationResponse } });
register('DELETE', '/v1/auth/passkeys/:id', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/auth/passkeys/options', { response: { 200: PasskeyOptionsResponse } });
register('POST', '/v1/auth/passkeys/verify', { response: { 200: AuthTokenResponse } });
register('POST', '/v1/auth/passkeys/reauth/options', { response: { 200: PasskeyOptionsResponse } });
register('POST', '/v1/auth/passkeys/reauth/verify', { response: { 200: AuthTokenResponse } });
register('POST', '/v1/billing/checkout', {
  headers: billingIdempotencyKeyHeadersSchema,
  body: billingCheckoutBodySchema,
  response: { 200: BillingCheckoutResponse, 201: BillingCheckoutResponse },
});
register('POST', '/v1/billing/portal', { response: { 200: UrlResponse } });
register('POST', '/v1/billing/cancel', { headers: billingIdempotencyKeyHeadersSchema, response: { 200: BillingCancelResponse } });
register('POST', '/v1/billing/subscription', { body: billingSubscriptionBodySchema, response: { 200: BillingSubscriptionUpdateResponse } });
register('GET', '/v1/dashboard/settings', { response: { 200: SchedulerSettingsResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('PUT', '/v1/dashboard/settings', {
  body: dashboardSettingsPatchBodySchema,
  response: { 200: SchedulerSettingsResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/users', { response: { 200: UserDirectoryResponse } });
register('GET', '/v1/dashboard/audit-log', { querystring: dashboardAuditLogQuerySchema, response: { 200: dashboardAuditLogResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/roles', { response: { 200: RolesResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } });
register('GET', '/v1/dashboard/projects', { response: { 200: ProjectListResponse } });
register('GET', '/v1/dashboard/projects/members', { response: { 200: ProjectMembersResponse } });
register('POST', '/v1/dashboard/projects', { body: ProjectInput, response: { 201: ProjectResponse } });
register('PATCH', '/v1/dashboard/projects/:id', { params: object({ id: Identifier }), body: ProjectPatchInput, response: { 200: ProjectResponse } });
register('POST', '/v1/dashboard/roles', {
  body: dashboardRoleCreateBodySchema,
  response: { 201: RoleResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('PATCH', '/v1/dashboard/roles/:id', {
  params: dashboardRoleParamsSchema,
  body: dashboardRoleUpdateBodySchema,
  response: { 200: RoleResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('POST', '/v1/dashboard/roles/reorder', {
  body: dashboardRoleReorderBodySchema,
  response: { 200: RolesResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('POST', '/v1/dashboard/users', { response: { 201: AllowedUserResponse } });
register('PATCH', '/v1/dashboard/users/:username', { params: object({ username: Identifier }), response: { 200: AllowedUserResponse } });
register('DELETE', '/v1/dashboard/users/:username', { params: object({ username: Identifier }), response: { 200: OkResponse } });
register('GET', '/v1/dashboard/keys/mine', { response: { 200: ApiKeyCollectionResponse } });
register('POST', '/v1/dashboard/keys/request', { response: { 201: ApiKeyResponse } });
register('POST', '/v1/dashboard/keys/create', { response: { 201: ApiKeySecretResponse } });
register('POST', '/v1/dashboard/keys/:id/reveal', { params: object({ id: Identifier }), response: { 200: object({ key: Type.String() }) } });
register('POST', '/v1/dashboard/keys/:id/regenerate', { params: object({ id: Identifier }), response: { 200: ApiKeyRegenerateResponse } });
register('DELETE', '/v1/dashboard/keys/:id', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('GET', '/v1/dashboard/keys/pending', { response: { 200: ApiKeyCollectionResponse } });
register('GET', '/v1/dashboard/keys/all', { querystring: object({ ...PaginationQuery.properties, search: Type.Optional(Type.String({ maxLength: 200 })) }), response: { 200: ApiKeyPageResponse } });
register('GET', '/v1/dashboard/keys/:id/usage', { params: object({ id: Identifier }), response: { 200: ApiKeyUsageResponse } });
register('GET', '/v1/dashboard/keys/:id/bundle-usage', { params: object({ id: Identifier }), response: { 200: ApiKeyBundleUsageResponse } });
register('GET', '/v1/dashboard/keys/:id/outcomes', { params: object({ id: Identifier }), response: { 200: ApiKeyOutcomeResponse } });
register('POST', '/v1/dashboard/keys/:id/approve', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/dashboard/keys/:id/deny', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('GET', '/v1/dashboard/backup/schedule', { response: { 200: backupScheduleResponseSchema } });
register('POST', '/v1/dashboard/backup/schedule', { body: backupSchedulePatchSchema, response: { 200: backupScheduleResponseSchema } });
register('GET', '/v1/dashboard/backup/history', { response: { 200: backupHistoryResponseSchema } });
register('POST', '/v1/dashboard/backup/history', { response: { 200: backupHistoryEntrySchema } });
register('POST', '/v1/dashboard/backup/import', { response: { 200: OkResponse } });
register('POST', '/v1/dashboard/backup/preview', { response: { 200: backupPreviewResponseSchema } });
register('POST', '/v1/dashboard/backup/drill', { response: { 200: backupDrillResponseSchema } });
register('DELETE', '/v1/dashboard/backup/history/:id', { params: backupHistoryParamsSchema, response: { 200: backupOkResponseSchema } });
register('POST', '/v1/decrypts', {
  headers: IdempotencyKeyHeaders,
  body: object({ bundleId: BundleId, version: Type.Optional(VersionSelector), projectId: Type.Optional(Identifier) }),
  response: { 200: DecryptJobResponse, 202: DecryptJobResponse, 409: ErrorEnvelope, 410: ErrorEnvelope, 502: ErrorEnvelope },
});
register('GET', '/v1/artifacts', {
  querystring: object({ ...PaginationQuery.properties, projectId: Type.Optional(Identifier), q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }),
  response: { 200: ApiArtifactPage },
});
register('GET', '/v1/artifacts/:id', { params: object({ id: Identifier }), querystring: object({ projectId: Type.Optional(Identifier) }), response: { 200: ArtifactSummaryResponse } });
register('GET', '/v1/jobs/:id', { params: object({ id: Identifier }), response: { 200: JobSummaryResponse } });
register('GET', '/v1/testflight/:appId/trains', {
  params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }),
  querystring: object({}),
  response: { 200: TestFlightTrainsResponse, 502: ErrorEnvelope },
});
register('GET', '/v1/testflight/:appId/builds', {
  params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }),
  querystring: object({ trainVersion: Type.String({ minLength: 1, maxLength: 64 }) }),
  response: { 200: TestFlightBuildsResponse, 502: ErrorEnvelope },
});
register('POST', '/v1/testflight/decrypt', {
  headers: IdempotencyKeyHeaders,
  body: object({ bundleId: BundleId, appId: TestFlightAppId, build: TestFlightBuildInput, projectId: Type.Optional(Identifier) }),
  response: { 202: JobSummaryResponse, 409: ErrorEnvelope, 410: ErrorEnvelope },
});
register('GET', '/v1/dashboard/artifacts', {
  querystring: object({ ...PaginationQuery.properties, projectId: Type.Optional(Identifier), q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }),
  response: { 200: DashboardArtifactPage },
});
register('PUT', '/v1/dashboard/artifacts/:id/pin', {
  params: object({ id: Identifier }),
  body: object({ pinned: Type.Boolean() }),
  response: { 200: ArtifactPinResponse },
});
register('GET', '/v1/dashboard/artifacts/retention-preview', {
  querystring: dashboardArtifactRetentionQuerySchema,
  response: { 200: ArtifactQuotaRetentionPreviewResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/testflight/:appId/trains', {
  params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }),
  querystring: object({ deviceId: Type.Optional(Identifier) }),
  response: { 200: TestFlightTrainsResponse },
});
register('GET', '/v1/dashboard/testflight/:appId/builds', {
  params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }),
  querystring: object({ trainVersion: Type.String({ minLength: 1, maxLength: 64 }), deviceId: Type.Optional(Identifier) }),
  response: { 200: TestFlightBuildsResponse },
});
register('POST', '/v1/dashboard/testflight/decrypt', {
  body: object({ bundleId: BundleId, appId: TestFlightAppId, build: TestFlightBuildInput, deviceId: Type.Optional(Identifier), preferPrimary: Type.Optional(Type.Boolean()), projectId: Type.Optional(Identifier) }),
  response: { 202: JobSummaryResponse },
});
register('GET', '/v1/dashboard/search', {
  querystring: object({ q: Type.String({ minLength: 1, maxLength: 200 }) }),
  response: { 200: SearchResponse },
});
register('GET', '/v1/dashboard/testflight/subscriptions', {
  querystring: PaginationQuery,
  response: { 200: testFlightSubscriptionPageSchema },
});
register('POST', '/v1/dashboard/testflight/subscriptions', {
  body: testFlightInviteBodySchema,
  response: {
    200: testFlightSubscriptionMutationResponseSchema,
    201: testFlightSubscriptionMutationResponseSchema,
    202: testFlightSubscriptionMutationResponseSchema,
    409: testFlightSubscriptionConflictResponseSchema,
  },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/approve', {
  params: testFlightSubscriptionParamsSchema,
  response: { 202: testFlightSubscriptionMutationResponseSchema },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/deny', {
  params: testFlightSubscriptionParamsSchema,
  response: { 200: testFlightSubscriptionMutationResponseSchema },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/sync', {
  params: testFlightSubscriptionParamsSchema,
  response: { 202: testFlightSubscriptionMutationResponseSchema },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/unsubscribe', {
  params: testFlightSubscriptionParamsSchema,
  response: { 202: testFlightSubscriptionMutationResponseSchema },
});
register('POST', '/v1/dashboard/testflight/catalog/:bundleId/unsubscribe', {
  params: testFlightCatalogBundleParamsSchema,
  response: { 200: testFlightDeviceUnsubscribeResponseSchema },
});
register('POST', '/v1/dashboard/decrypt/preflight', {
  body: object({ bundleId: BundleId, testflight: Type.Optional(Type.Boolean()), versionLabel: Type.Optional(Type.String({ maxLength: 64 })), installSizeBytes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), deviceId: Type.Optional(Identifier), projectId: Type.Optional(Identifier) }),
  response: { 200: DashboardDecryptPreflightResponse },
});
register('GET', '/v1/dashboard/versions/:bundleId', {
  params: object({ bundleId: BundleId }),
  querystring: object({ force: Type.Optional(Type.Literal('true')) }),
  response: { 200: VersionsResponse },
});
register('POST', '/v1/dashboard/devices/setup', {
  body: DeviceConnectionInput,
  response: { 201: DeviceSetupResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 502: ErrorEnvelope },
});
register('POST', '/v1/dashboard/devices', {
  body: DeviceRecordInput,
  response: { 201: DeviceResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('PATCH', '/v1/dashboard/devices/:id', {
  params: object({ id: Identifier }),
  body: DevicePatchInput,
  response: { 200: DeviceResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('GET', '/v1/dashboard/jobs/export', {
  querystring: object({ format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('csv')])), projectId: Type.Optional(Identifier) }),
  response: { 200: JobExportResponse },
});
register('POST', '/v1/dashboard/jobs/bulk-preview', {
  body: object({ ids: Type.Array(Identifier, { maxItems: 100 }), projectId: Type.Optional(Identifier) }),
  response: { 200: BulkPreviewResponse },
});
register('GET', '/v1/dashboard/jobs/eta/:bundleId', {
  params: object({ bundleId: BundleId }),
  querystring: object({ projectId: Type.Optional(Identifier) }),
  response: { 200: JobEtaResponse },
});
register('GET', '/v1/dashboard/jobs/stats/:bundleId', {
  params: object({ bundleId: BundleId }),
  querystring: object({ projectId: Type.Optional(Identifier) }),
  response: { 200: BundleStatsResponse },
});
register('GET', '/v1/dashboard/jobs/volume', {
  querystring: object({ days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })), projectId: Type.Optional(Identifier) }),
  response: { 200: DailyVolumeResponse },
});
register('GET', '/v1/dashboard/jobs/slo', {
  querystring: object({ projectId: Type.Optional(Identifier) }),
  response: { 200: JobSloResponse },
});
register('GET', '/v1/dashboard/jobs/diff', {
  querystring: object({ bundleId: BundleId, a: Identifier, b: Identifier, projectId: Type.Optional(Identifier) }),
  response: { 200: JobDiffResponse },
});
register('GET', '/v1/dashboard/insights', {
  querystring: object({ topApps: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })), trendDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })), projectId: Type.Optional(Identifier) }),
  response: { 200: InsightsResponse },
});
register('GET', '/v1/dashboard/failure-patterns', { querystring: object({ projectId: Type.Optional(Identifier) }), response: { 200: FailurePatternsResponse } });
register('GET', '/v1/dashboard/storage-forecast', { querystring: object({ projectId: Type.Optional(Identifier) }), response: { 200: StorageForecastResponse } });
register('GET', '/v1/dashboard/watches', { response: { 200: WatchListResponse } });
register('GET', '/v1/dashboard/watches/export', { response: { 200: WatchExportResponse } });
register('GET', '/v1/dashboard/watches/health', { response: { 200: WatchHealthResponse } });
register('GET', '/v1/dashboard/watches/calendar', {
  querystring: object({ hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })), fromAt: Type.Optional(Type.Integer()), projectId: Type.Optional(Identifier) }),
  response: { 200: WatchCalendarResponse },
});
register('GET', '/v1/dashboard/github/budget-history', {
  querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), projectId: Type.Optional(Identifier) }),
  response: { 200: GitHubBudgetHistoryResponse },
});
register('GET', '/v1/dashboard/github/repos', { response: { 200: GitHubReposResponse } });
register('GET', '/v1/dashboard/github/workflows', {
  querystring: object({ repo: Type.String({ minLength: 3, maxLength: 200, pattern: '^[\\w.-]+/[\\w.-]+$' }) }),
  response: { 200: GitHubWorkflowsResponse },
});
register('POST', '/v1/dashboard/watches', { body: WatchInput, response: { 201: WatchResponse } });
register('PATCH', '/v1/dashboard/watches/:id', { params: object({ id: Identifier }), body: Type.Partial(WatchInput), response: { 200: WatchResponse } });
register('DELETE', '/v1/dashboard/watches/:id', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/dashboard/watches/import', {
  body: object({ watches: Type.Array(WatchInput, { minItems: 1, maxItems: 100 }) }),
  response: { 201: WatchImportResponse },
});
register('POST', '/v1/dashboard/watches/preview-dispatch-draft', {
  body: object({ bundleId: BundleId, repo: Type.String({ minLength: 3, maxLength: 200, pattern: '^[\\w.-]+/[\\w.-]+$' }) }),
  response: { 200: DispatchPreviewResponse },
});
register('POST', '/v1/dashboard/watches/validate-dispatch-draft', {
  body: object({ targets: Type.Array(DispatchTargetInput, { minItems: 1, maxItems: 10 }) }),
  response: { 200: DispatchValidationResponse },
});
register('GET', '/v1/dashboard/watches/:id/preview-dispatch', { params: object({ id: Identifier }), response: { 200: DispatchPreviewResponse } });
register('GET', '/v1/dashboard/watches/:id/preview-dispatch/:source', {
  params: object({ id: Identifier, source: Type.Union([Type.Literal('app-store'), Type.Literal('testflight')]) }),
  response: { 200: DispatchSourcePreviewResponse },
});
register('POST', '/v1/dashboard/watches/:id/trigger-dispatch', { params: object({ id: Identifier }), response: { 202: JsonObject, 409: JsonObject } });
register('GET', '/v1/dashboard/apps/metadata', {
  querystring: object({ bundleIds: Type.Optional(Type.String({ maxLength: 20_000 })) }),
  response: { 200: AppMetadataResponse },
});
register('GET', '/v1/dashboard/apps/cache', { response: { 200: AppCatalogStatsResponse } });
register('POST', '/v1/dashboard/apps/metadata/refresh', {
  body: object({ bundleIds: Type.Array(BundleId, { minItems: 1, maxItems: 40 }) }),
  response: { 200: AppMetadataResponse },
});
register('GET', '/v1/dashboard/settings/job-history-retention/preview', {
  querystring: dashboardSettingsRetentionQuerySchema,
  response: { 200: RetentionPreviewResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('GET', '/v1/dashboard/settings/validate-cron', {
  querystring: dashboardSettingsCronQuerySchema,
  response: { 200: object({ valid: Type.Boolean() }), 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('POST', '/v1/dashboard/settings/test-webhook', {
  body: dashboardSettingsWebhookTestBodySchema,
  response: { 200: TestWebhookResponse, 400: Type.Union([TestWebhookResponse, ErrorEnvelope]), 401: ErrorEnvelope, 403: ErrorEnvelope },
});
register('POST', '/v1/dashboard/notifications/read', {
  body: notificationReadBodySchema,
  response: { 200: notificationReadResponseSchema },
});
register('POST', '/v1/dashboard/jobs/:id/cancel', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/dashboard/jobs/:id/prioritize', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/dashboard/jobs/:id/retry', { params: object({ id: Identifier }), response: { 202: JobSummaryResponse } });
register('POST', '/v1/dashboard/jobs/reorder', {
  body: object({ ids: Type.Array(Identifier, { maxItems: 100 }), projectId: Type.Optional(Identifier) }),
  response: { 200: OkResponse },
});
register('GET', '/v1/dashboard/logs', {
  querystring: dashboardLogsQuerySchema,
  response: { 200: dashboardLogsResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('GET', '/v1/dashboard/webhooks', {
  querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
  response: { 200: WebhookDeliveryPageResponse },
});
register('GET', '/v1/dashboard/events', {
  querystring: object({ projectId: Type.Optional(Identifier) }),
  response: { 200: EventStreamResponse },
});
register('GET', '/v1/dashboard/jobs/:id/diagnostic', {
  params: object({ id: Identifier }),
  response: { 200: DiagnosticResponse },
});
register('GET', '/v1/dashboard/support-bundle', {
  querystring: object({ projectId: Type.Optional(Identifier) }),
  response: { 200: SupportBundleResponse },
});
register('GET', '/v1/dashboard/github/rate-limit', {
  response: { 200: GitHubRateLimitResponse },
});
register('GET', '/v1/dashboard/audit-log/export', {
  querystring: object({ format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('csv')])) }),
  response: { 200: AuditExportResponse },
});
register('GET', '/v1/dashboard/jobs/export', {
  querystring: object({ format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('csv')])), projectId: Type.Optional(Identifier) }),
  response: { 200: JobExportResponse },
});
register('GET', '/v1/dashboard/watches/export', {
  response: { 200: WatchExportResponse },
});
register('GET', '/v1/dashboard/backup/export', {
  response: { 200: backupExportResponseSchema },
});
register('GET', '/v1/dashboard/backup/history/:id/download', {
  params: object({ id: Identifier }),
  response: { 200: BinaryFileResponse },
});
register('POST', '/v1/dashboard/backup/history/:id/drill', {
  params: backupHistoryParamsSchema,
  response: { 200: backupSnapshotDrillResponseSchema },
});
register('POST', '/v1/dashboard/backup/import', {
  body: backupImportBodySchema,
  response: { 200: backupOkResponseSchema },
});
register('POST', '/v1/dashboard/backup/preview', {
  body: backupImportBodySchema,
  response: { 200: backupPreviewResponseSchema },
});
register('POST', '/v1/dashboard/backup/drill', {
  body: backupImportBodySchema,
  response: { 200: backupDrillResponseSchema },
});
register('DELETE', '/v1/dashboard/backup/history/:id', {
  params: backupHistoryParamsSchema,
  response: { 200: backupOkResponseSchema },
});
register('GET', '/v1/dashboard/discord/status', {
  response: { 200: DiscordStatusResponse },
});
register('GET', '/v1/dashboard/discord/guilds', {
  response: { 200: DiscordGuildsResponse },
});
register('POST', '/v1/dashboard/discord/guilds', {
  body: object({ guilds: Type.Array(DiscordGuildResponse) }),
  response: { 200: DiscordGuildUpdateResponse },
});
register('GET', '/v1/dashboard/discord/roles', {
  querystring: object({ guildId: Identifier }),
  response: { 200: DiscordRolesResponse },
});
register('GET', '/v1/dashboard/discord/perks', {
  response: { 200: DiscordPerksResponse },
});
register('POST', '/v1/dashboard/discord/perks', {
  body: object({
    guildId: Identifier,
    guildName: Type.String({ minLength: 1, maxLength: 200 }),
    guildIcon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    discordRoleId: Identifier,
    discordRoleName: Type.String({ minLength: 1, maxLength: 200 }),
    discordRoleColor: Type.Integer({ minimum: 0 }),
    appRoleId: Identifier,
  }),
  response: { 201: DiscordRolePerkResponse },
});
register('DELETE', '/v1/dashboard/discord/perks/:id', {
  params: object({ id: Identifier }),
  response: { 200: OkResponse },
});
register('POST', '/v1/dashboard/keys/bulk-revoke', {
  body: object({ ids: Type.Array(Identifier, { maxItems: 100 }) }),
  response: { 200: ApiKeyRevokedResponse },
});
register('POST', '/v1/dashboard/keys/bulk-extend-expiry', {
  body: object({ ids: Type.Array(Identifier, { maxItems: 100 }), days: Type.Integer({ minimum: 1, maximum: 3650 }) }),
  response: { 200: ApiKeyExtendedResponse },
});
register('POST', '/v1/dashboard/keys/bulk-set-daily-limit', {
  body: object({ ids: Type.Array(Identifier, { maxItems: 100 }), dailyLimit: Type.Union([Type.Number(), Type.Null()]) }),
  response: { 200: ApiKeyUpdatedResponse },
});
register('POST', '/v1/dashboard/keys/bulk-set-scope', {
  body: object({ ids: Type.Array(Identifier, { maxItems: 100 }), allowedBundleIds: Type.Union([Type.Array(BundleId, { maxItems: 25 }), Type.Null()]) }),
  response: { 200: ApiKeyUpdatedResponse },
});
register('POST', '/v1/dashboard/keys/bulk-approve', {
  body: object({ ids: Type.Array(Identifier, { maxItems: 100 }) }),
  response: { 200: ApiKeyApprovedResponse },
});
register('PATCH', '/v1/dashboard/keys/:id/priority', {
  params: object({ id: Identifier }),
  body: object({ priority: Type.Number() }),
  response: { 200: ApiKeyPriorityResponse },
});
register('PATCH', '/v1/dashboard/keys/:id/max-concurrent', {
  params: object({ id: Identifier }),
  body: object({ maxConcurrent: Type.Optional(Type.Union([Type.Number(), Type.Null()])) }),
  response: { 200: ApiKeyConcurrencyResponse },
});
register('PATCH', '/v1/dashboard/keys/:id/allow-testflight', {
  params: object({ id: Identifier }),
  body: object({ allowTestFlight: Type.Boolean() }),
  response: { 200: ApiKeyTestFlightResponse },
});
register('GET', '/v1/dashboard/me/prefs', {
  response: { 200: userPrefsResponseSchema },
});
register('PUT', '/v1/dashboard/me/prefs', {
  body: userPrefsPatchBodySchema,
  response: { 200: userPrefsResponseSchema },
});
register('GET', '/v1/dashboard/push/public-key', {
  response: { 200: pushKeyResponseSchema },
});
register('POST', '/v1/dashboard/push/subscribe', {
  body: pushSubscriptionBodySchema,
  response: { 200: OkResponse },
});
register('POST', '/v1/dashboard/push/unsubscribe', {
  body: pushUnsubscribeBodySchema,
  response: { 200: OkResponse },
});
register('POST', '/v1/dashboard/push/test', {
  response: { 200: OkResponse },
});
register('POST', '/v1/dashboard/email/test', {
  response: { 200: OkResponse },
});
register('GET', '/v1/dashboard/testflight/diagnostics', {
  response: { 200: TestFlightDiagnosticsResponse },
});
register('POST', '/v1/dashboard/watches/:id/trigger-dispatch', {
  params: object({ id: Identifier }),
  response: { 202: DispatchTriggerResponse, 409: DispatchTriggerResponse },
});
register('POST', '/v1/stripe/webhook', {
  headers: object({ 'stripe-signature': Type.String({ minLength: 1, maxLength: 200 }) }),
  body: Type.Any(),
  response: { 200: WebhookReceiptResponse },
});
register('POST', '/v1/nowpayments/webhook', {
  headers: object({ 'x-nowpayments-sig': Type.String({ minLength: 1, maxLength: 500 }) }),
  body: Type.Any(),
  response: { 200: WebhookReceiptResponse },
});
register('GET', '/v1/metrics', {
  response: { 200: PrometheusResponse },
});
register('GET', '/v1/decrypt', {
  headers: IdempotencyKeyHeaders,
  querystring: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), version: Type.Optional(VersionSelector), projectId: Type.Optional(Identifier) }),
  response: {
    200: BinaryFileResponse,
    202: JobSummaryResponse,
    409: Type.Union([JobSummaryResponse, ErrorEnvelope]),
    410: ErrorEnvelope,
    500: Type.Union([JobSummaryResponse, ErrorEnvelope]),
  },
});
register('POST', '/v1/dashboard/decrypt', {
  body: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), versionLabel: Type.Optional(Type.String({ maxLength: 64 })), preferPrimary: Type.Optional(Type.Boolean()), projectId: Type.Optional(Identifier) }),
  response: { 202: JobSummaryResponse },
});
register('GET', '/v1/artifacts/:id/file', {
  params: object({ id: Identifier }),
  querystring: object({ projectId: Type.Optional(Identifier) }),
  response: { 200: BinaryFileResponse },
});
register('GET', '/v1/dashboard/artifacts/:id/file', {
  params: object({ id: Identifier }),
  response: { 200: BinaryFileResponse },
});
register('DELETE', '/v1/dashboard/devices/:id', {
  params: object({ id: Identifier }),
  response: { 200: OkResponse, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('DELETE', '/v1/dashboard/roles/:id', {
  params: dashboardRoleParamsSchema,
  response: { 200: dashboardRoleOkResponseSchema, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope },
});
register('POST', '/v1/billing/webhooks/inbox/:id/replay', {
  params: billingWebhookInboxParamsSchema,
  response: { 200: WebhookReplayResponse },
});
register('POST', '/v1/billing/webhooks/inbox/:id/quarantine', {
  params: billingWebhookInboxParamsSchema,
  body: billingWebhookQuarantineBodySchema,
  response: { 200: WebhookQuarantineResponse },
});
for (const provider of ['github', 'discord'] as const) {
  register('GET', `/v1/auth/${provider}/login`, { response: { 302: Type.String() } });
  register('GET', `/v1/auth/${provider}/connect`, { response: { 302: Type.String() } });
  register('GET', `/v1/auth/${provider}/callback`, { response: { 302: Type.String() } });
}

export function getRouteContract(method: string, path: string): FastifySchema | undefined {
  const key = `${method} ${path}`;
  const current = contracts.get(key);
  if (current) return current;
  throw new Error(`missing route contract for ${key}`);
}

export function getRouteContracts(): ReadonlyMap<string, FastifySchema> {
  return contracts;
}
