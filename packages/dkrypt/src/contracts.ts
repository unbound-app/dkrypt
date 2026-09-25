import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifySchema } from 'fastify';

const BundleId = Type.String({ minLength: 3, maxLength: 200, pattern: '^[A-Za-z0-9.-]+$' });
const VersionSelector = Type.String({ minLength: 1, maxLength: 64, pattern: '^v?\\d+(?:\\.\\d+)*(?:_\\d+)?$' });
const Identifier = Type.String({ minLength: 1, maxLength: 200 });
const JsonObject = Type.Object({}, { additionalProperties: true });
const JsonResponse = Type.Union([JsonObject, Type.Array(Type.Unknown()), Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const ErrorEnvelope = Type.Object(
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
const PaginationQuery = object({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) });
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
const DeviceTransportState = Type.Union([
  Type.Literal('discovered'),
  Type.Literal('pairing'),
  Type.Literal('connecting'),
  Type.Literal('ready'),
  Type.Literal('degraded'),
  Type.Literal('recovering'),
  Type.Literal('offline'),
  Type.Literal('unsupported'),
]);
const DeviceSubsystemState = Type.Union([Type.Literal('ready'), Type.Literal('degraded'), Type.Literal('offline'), Type.Literal('unsupported'), Type.Literal('unknown')]);
const DeviceHealthResponse = object({
  reachable: Type.Boolean(),
  transport: Type.Optional(Type.Union([Type.Literal('wifi'), Type.Literal('usb')])),
  transportState: Type.Optional(DeviceTransportState),
  capabilities: Type.Optional(Type.Array(Type.String())),
  lastSeenAt: Type.Optional(Type.Number()),
  recoveryState: Type.Optional(Type.Union([Type.Literal('stable'), Type.Literal('recovering'), Type.Literal('degraded'), Type.Literal('offline')])),
  error: Type.Optional(Type.String()),
  testFlightRunning: Type.Optional(Type.Boolean()),
  testFlightBridgeReachable: Type.Optional(Type.Boolean()),
  darkEnabled: Type.Optional(Type.Boolean()),
  screenIsOn: Type.Optional(Type.Boolean()),
  backlightState: Type.Optional(Type.Number()),
  batteryPercent: Type.Optional(Type.Number()),
  batteryCharging: Type.Optional(Type.Boolean()),
  batteryTemperatureC: Type.Optional(Type.Number()),
  batteryCycleCount: Type.Optional(Type.Number()),
  batteryHealthPercent: Type.Optional(Type.Number()),
  batteryDesignCapacityMah: Type.Optional(Type.Number()),
  batteryMaxCapacityMah: Type.Optional(Type.Number()),
  storageTotalBytes: Type.Optional(Type.Number()),
  storageUsedBytes: Type.Optional(Type.Number()),
  storageFreeBytes: Type.Optional(Type.Number()),
  storageUsedPercent: Type.Optional(Type.Number()),
  networkConnected: Type.Optional(Type.Boolean()),
  internetAccess: Type.Optional(Type.Boolean()),
  networkIpAddress: Type.Optional(Type.String()),
  networkInterface: Type.Optional(Type.String()),
  bridgeHeartbeats: Type.Optional(JsonObject),
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
  readiness: Type.Optional(object({ score: Type.Number(), state: Type.Union([Type.Literal('ready'), Type.Literal('caution'), Type.Literal('blocked')]), reasons: Type.Array(Type.String()) })),
  checkedAt: Type.String(),
});
const JobSummaryResponse = object({
  id: Identifier,
  correlationId: Identifier,
  bundleId: BundleId,
  externalVersionId: Type.Optional(Identifier),
  testflight: Type.Optional(object({ appId: Type.Number(), buildId: Type.Number(), version: Type.Optional(Type.String()), buildNumber: Type.Optional(Type.String()) })),
  versionLabel: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal('manual'), Type.Literal('scheduler')]),
  channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
  queuedBy: Type.Optional(Type.String()),
  priority: Type.Number(),
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
  device: object({ reachable: Type.Boolean(), bridgeReachable: Type.Boolean(), readiness: Type.String() }),
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
const DashboardOverviewResponse = object({
  schedulerEnabled: Type.Boolean(),
  settings: JsonObject,
  watches: Type.Array(JsonObject),
  devices: Type.Array(JsonObject),
  lastSchedulerRunAt: Type.Optional(Type.Number()),
  schedulerRunHistory: Type.Array(JsonObject),
  disk: Type.Optional(JsonObject),
  isPaidPlan: Type.Boolean(),
  maintenance: JsonObject,
  activeJobs: Type.Array(JsonObject),
});
const JobHistoryPage = object({ history: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const ArtifactPage = object({ artifacts: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), totalBytes: Type.Number(), maxBytes: Type.Number(), nextCursor: PageCursor });
const DeviceResponse = object({
  id: Identifier,
  name: Type.String(),
  enabled: Type.Boolean(),
  isPrimary: Type.Optional(Type.Boolean()),
  transport: Type.Union([Type.Literal('wifi'), Type.Literal('usb')]),
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
  transportState: DeviceTransportState,
  transportCapabilities: Type.Array(Type.String()),
  lastSeenAt: Type.Optional(Type.Number()),
  recoveryState: Type.Union([Type.Literal('stable'), Type.Literal('recovering'), Type.Literal('degraded'), Type.Literal('offline')]),
});
const DeviceListResponse = object({ devices: Type.Array(DeviceResponse) });
const DevicePreflightResponse = object({ device: JsonObject, health: JsonObject, bridge: JsonObject, checks: Type.Array(JsonObject), ready: Type.Boolean() });
const JobTimelineResponse = object({
  id: Identifier,
  correlationId: Identifier,
  bundleId: BundleId,
  status: JobStatus,
  versionLabel: Type.Optional(Type.String()),
  deviceId: Type.Optional(Identifier),
  sizeBytes: Type.Optional(Type.Number()),
  warnings: Type.Optional(Type.Array(Type.String())),
  ipaMetadata: Type.Optional(JsonObject),
  ipaInfoPlist: Type.Optional(JsonObject),
  events: Type.Array(JsonObject),
  guidance: Type.Optional(JsonObject),
});
const TestFlightCatalogAppResponse = object({
  appId: Type.Integer({ minimum: 1 }),
  bundleId: BundleId,
  displayName: Type.String(),
  iconUrl: Type.Optional(Type.String()),
  sellerName: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  devices: Type.Array(object({ id: Identifier, name: Type.String() })),
  lastVerifiedAt: Type.Number(),
  deviceSource: Type.Literal(true),
});
const TestFlightCatalogResponse = object({ apps: Type.Array(TestFlightCatalogAppResponse), fetchedAt: Type.Optional(Type.Number()), refreshing: Type.Boolean() });
const TestFlightSubscriptionDeviceResponse = object({
  deviceId: Identifier,
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('syncing'),
    Type.Literal('active'),
    Type.Literal('unavailable'),
    Type.Literal('unsupported'),
    Type.Literal('error'),
    Type.Literal('unsubscribed'),
  ]),
  appleMembership: Type.Optional(Type.Union([Type.Literal('accepted'), Type.Literal('pending'), Type.Literal('unknown')])),
  lastVerifiedAt: Type.Optional(Type.Number()),
  lastSyncedAt: Type.Optional(Type.Number()),
  lastError: Type.Optional(Type.String()),
});
const TestFlightSubscriptionResponse = object({
  id: Identifier,
  url: Type.String(),
  inviteCode: Type.String(),
  requestedBy: Identifier,
  status: Type.Union([Type.Literal('pending'), Type.Literal('approved'), Type.Literal('denied'), Type.Literal('withdrawn')]),
  appId: Type.Optional(Type.Integer({ minimum: 1 })),
  bundleId: Type.Optional(BundleId),
  displayName: Type.Optional(Type.String()),
  iconUrl: Type.Optional(Type.String()),
  sellerName: Type.Optional(Type.String()),
  category: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  approvedAt: Type.Optional(Type.Number()),
  approvedBy: Type.Optional(Identifier),
  deniedAt: Type.Optional(Type.Number()),
  deniedBy: Type.Optional(Identifier),
  withdrawnAt: Type.Optional(Type.Number()),
  withdrawnBy: Type.Optional(Identifier),
  devices: Type.Array(TestFlightSubscriptionDeviceResponse),
  devicePolicy: Type.Literal('all-enabled'),
});
const TestFlightSubscriptionPage = object({ subscriptions: Type.Array(TestFlightSubscriptionResponse), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const TestFlightSubscriptionMutationResponse = object({ subscription: TestFlightSubscriptionResponse });
const TestFlightDeviceUnsubscribeResponse = object({ bundleId: BundleId, removedDeviceIds: Type.Array(Identifier), failures: Type.Array(Type.String()) });
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
const DeviceSetupResponse = object({ device: DeviceResponse, setup: JsonObject });
const DeviceInventoryResponse = object({ deviceId: Identifier, bundles: Type.Array(JsonObject) });
const BridgeActionResponse = object({ result: JsonObject });
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
const DoctorResponse = object({
  ok: Type.Boolean(),
  checkedAt: Type.String(),
  checks: Type.Array(object({ id: Identifier, status: Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('error')]), detail: Type.String() })),
});
const SyntheticResponse = object({
  ok: Type.Boolean(),
  checkedAt: Type.String(),
  probes: Type.Array(object({ id: Identifier, status: Type.Union([Type.Literal('ok'), Type.Literal('warn'), Type.Literal('error'), Type.Literal('skipped')]), durationMs: Type.Number(), detail: Type.String() })),
});
const NotificationPage = object({ notifications: Type.Array(JsonObject), unread: Type.Integer({ minimum: 0 }), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const WebhookInboxPage = object({ inbox: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const DeviceDiscoveryResponse = object({ devices: Type.Array(JsonObject), scannedNetworks: Type.Array(Type.String()), warnings: Type.Array(Type.String()) });
const DeviceHealthHistoryResponse = object({ buckets: Type.Array(JsonObject), uptimePercent: Type.Union([Type.Number(), Type.Null()]) });
const DeviceActivityResponse = object({ activity: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
const DeviceHistoryResponse = object({ buckets: Type.Array(JsonObject) });
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
  sourceJobId: Type.Optional(Identifier),
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
const SchedulerSettingsResponse = object({
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
});
const RoleResponse = object({
  id: Identifier,
  name: Type.String(),
  color: Type.String(),
  permissions: Type.String(),
  position: Type.Integer({ minimum: 0 }),
  isDefault: Type.Boolean(),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
const RolesResponse = object({ roles: Type.Array(RoleResponse) });
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
const AuditLogPage = object({ entries: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
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
const BackupScheduleResponse = object({ enabled: Type.Boolean(), cron: Type.String(), retentionCount: Type.Integer({ minimum: 1 }) });
const BackupHistoryEntryResponse = object({
  id: Identifier,
  createdAt: Type.Number(),
  sizeBytes: Type.Number({ minimum: 0 }),
  filename: Type.String(),
  trigger: Type.Union([Type.Literal('scheduled'), Type.Literal('manual')]),
  databaseFilename: Type.Optional(Type.String()),
  manifestFilename: Type.Optional(Type.String()),
  schemaVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  integrity: Type.Optional(Type.Union([Type.Literal('verified'), Type.Literal('failed')])),
  encryptedManifest: Type.Optional(Type.Boolean()),
});
const BackupHistoryResponse = Type.Array(BackupHistoryEntryResponse);
const BackupPreviewResponse = object({
  exportedAt: Type.Optional(Type.Number()),
  incoming: object({ users: Type.Integer({ minimum: 0 }), roles: Type.Integer({ minimum: 0 }), apiKeys: Type.Integer({ minimum: 0 }), watches: Type.Integer({ minimum: 0 }), devices: Type.Integer({ minimum: 0 }), jobHistory: Type.Integer({ minimum: 0 }), auditLog: Type.Integer({ minimum: 0 }) }),
  current: object({ users: Type.Integer({ minimum: 0 }), roles: Type.Integer({ minimum: 0 }), apiKeys: Type.Integer({ minimum: 0 }), watches: Type.Integer({ minimum: 0 }), devices: Type.Integer({ minimum: 0 }), jobHistory: Type.Integer({ minimum: 0 }), auditLog: Type.Integer({ minimum: 0 }) }),
});
const BackupDrillResponse = object({
  ok: Type.Boolean(),
  checks: Type.Array(object({ label: Type.String(), ok: Type.Boolean(), detail: Type.String() })),
  database: Type.Optional(JsonObject),
});
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
const OkResponse = object({ ok: Type.Boolean() });
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
const WatchResponse = object({
  id: Identifier,
  bundleId: BundleId,
  repo: Type.String(),
  ghWorkflowFile: Type.String(),
  dispatchTargets: Type.Optional(Type.Array(JsonObject)),
  pollCron: Type.String(),
  enabled: Type.Boolean(),
  webhookUrl: Type.Optional(Type.String()),
  testFlightPolicy: Type.Optional(Type.Union([Type.Literal('latest'), Type.Literal('latestNonExpired'), Type.Literal('train')])),
  testFlightTrain: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
  schedulable: Type.Optional(Type.Boolean()),
  configIssues: Type.Optional(Type.Array(Type.String())),
});
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
const RetentionPreviewResponse = object({
  retentionDays: Type.Integer({ minimum: 0 }),
  cutoff: Type.Optional(Type.Number()),
  retained: Type.Integer({ minimum: 0 }),
  removed: Type.Integer({ minimum: 0 }),
  artifacts: object({ retained: Type.Integer({ minimum: 0 }), retainedBytes: Type.Number({ minimum: 0 }), maxBytes: Type.Number({ minimum: 0 }), reclaimable: Type.Integer({ minimum: 0 }), reclaimableBytes: Type.Number({ minimum: 0 }) }),
});
const TestWebhookResponse = object({ ok: Type.Boolean(), error: Type.Optional(Type.String()) });
const LogsPageResponse = object({ logs: Type.Array(JsonObject), total: Type.Integer({ minimum: 0 }), nextCursor: PageCursor });
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
const UserPrefsResponse = object({
  theme: Type.Optional(Type.Union([Type.Literal('dark'), Type.Literal('light'), Type.Literal('auto')])),
  density: Type.Optional(Type.Union([Type.Literal('comfortable'), Type.Literal('compact')])),
  accent: Type.Optional(Type.String()),
  sound: Type.Optional(Type.Boolean()),
  pushOnSuccess: Type.Optional(Type.Boolean()),
  pushOnFailure: Type.Optional(Type.Boolean()),
  pushOnAlerts: Type.Optional(Type.Boolean()),
  pushOnKeyExpiry: Type.Optional(Type.Boolean()),
  emailOnSuccess: Type.Optional(Type.Boolean()),
  emailOnFailure: Type.Optional(Type.Boolean()),
  emailOnAlerts: Type.Optional(Type.Boolean()),
  emailOnKeyExpiry: Type.Optional(Type.Boolean()),
  notifyEmail: Type.Optional(Type.String()),
  preferPrimaryDevice: Type.Optional(Type.Boolean()),
  accountEmail: Type.Optional(Type.String()),
});
const PushKeyResponse = object({ publicKey: Type.String() });
const BackupExportResponse = object({
  backupVersion: Type.Integer({ minimum: 1 }),
  exportedAt: Type.Number(),
  allowedUsers: Type.Array(JsonObject),
  roles: Type.Array(JsonObject),
  apiKeys: Type.Array(JsonObject),
  settings: JsonObject,
  watches: Type.Array(JsonObject),
  devices: Type.Array(JsonObject),
  jobHistory: Type.Array(JsonObject),
  lastSchedulerRunAt: Type.Optional(Type.Number()),
  userPrefs: JsonObject,
  auditLog: Type.Array(JsonObject),
  schedulerRunHistory: Type.Array(JsonObject),
  rootSessionVersion: Type.Number(),
  apiKeyUsage: JsonObject,
  apiKeyBundleUsage: Type.Optional(JsonObject),
  deviceActivity: Type.Array(JsonObject),
  testFlightSubscriptions: Type.Array(JsonObject),
  rootMfa: Type.Optional(JsonObject),
  passkeys: Type.Array(JsonObject),
  billing: JsonObject,
  identities: JsonObject,
});
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
const BinaryFileResponse = Type.String({ format: 'binary' });
const WebhookReplayResponse = object({ replayed: Type.Boolean(), duplicate: Type.Optional(Type.Boolean()), status: Type.String() });
const WebhookQuarantineResponse = object({ record: Type.Optional(JsonObject) });
const DeviceConnectionInput = object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  existingId: Type.Optional(Identifier),
  transport: Type.Optional(Type.Union([Type.Literal('wifi'), Type.Literal('usb')])),
  host: Type.Optional(Type.String({ minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9._-]+$' })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  user: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  udid: Type.Optional(Type.String({ minLength: 8, maxLength: 80, pattern: '^[A-Za-z0-9-]+$' })),
  usbmuxNetwork: Type.Optional(Type.Boolean()),
  productType: Type.Optional(Type.String({ maxLength: 120 })),
  iosVersion: Type.Optional(Type.String({ maxLength: 64 })),
  toolchain: Type.Optional(Type.String({ maxLength: 120 })),
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
});
const DeviceRecordInput = object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  transport: Type.Optional(Type.Union([Type.Literal('wifi'), Type.Literal('usb')])),
  host: Type.Optional(Type.String({ minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9._-]+$' })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  user: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  udid: Type.Optional(Type.String({ minLength: 8, maxLength: 80, pattern: '^[A-Za-z0-9-]+$' })),
  usbmuxNetwork: Type.Optional(Type.Boolean()),
  productType: Type.Optional(Type.String({ maxLength: 120 })),
  iosVersion: Type.Optional(Type.String({ maxLength: 64 })),
  toolchain: Type.Optional(Type.String({ maxLength: 120 })),
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
  enabled: Type.Optional(Type.Boolean()),
  isPrimary: Type.Optional(Type.Boolean()),
});
const DevicePatchInput = Type.Partial(DeviceRecordInput);
const DispatchTargetInput = object({
  repo: Type.String({ minLength: 3, maxLength: 200, pattern: '^[\\w.-]+/[\\w.-]+$' }),
  ghWorkflowFile: Type.String({ minLength: 1, maxLength: 200 }),
  mode: Type.Optional(Type.Union([Type.Literal('repository_dispatch'), Type.Literal('workflow_dispatch')])),
  ref: Type.Optional(Type.String({ maxLength: 200 })),
  inputs: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 100 }), Type.String({ maxLength: 500 }))),
});
const WatchInput = object({
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

const contracts = new Map<string, FastifySchema>();

function register(method: string, path: string, schema: FastifySchema): void {
  const customResponses = schema.response as Record<string, unknown> | undefined;
  contracts.set(`${method} ${path}`, {
    tags: schema.tags ?? [path.startsWith('/v1/dashboard') ? 'dashboard' : 'public'],
    summary: schema.summary ?? `${method} ${path}`,
    ...schema,
    response: {
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

function registerGenericContract(method: ContractMethod, path: string): void {
  const parameterNames = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  const schema: FastifySchema = {};
  if (parameterNames.length > 0) {
    schema.params = Type.Object(Object.fromEntries(parameterNames.map((name) => [name, Identifier])), { additionalProperties: false });
  }
  if (method === 'GET') {
    schema.querystring = JsonObject;
  } else if (method !== 'DELETE') {
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

register('POST', '/v1/decrypts', {
  body: object({ bundleId: BundleId, version: Type.Optional(VersionSelector) }),
});

register('GET', '/v1/status', {
  tags: ['public'],
  summary: 'Public service status',
  response: { 200: PublicStatusResponse },
});

register('GET', '/v1/decrypt', {
  querystring: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), version: Type.Optional(VersionSelector) }),
});

register('POST', '/v1/testflight/decrypt', {
  body: object({ bundleId: BundleId, appId: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Integer({ minimum: 1 })]), build: Type.Record(Type.String(), Type.Unknown()) }),
});

register('POST', '/v1/billing/checkout', {
  headers: object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
  body: object({ planId: Identifier, provider: Type.Optional(Type.Union([Type.Literal('stripe'), Type.Literal('crypto')])), cryptoAsset: Type.Optional(Type.String({ minLength: 2, maxLength: 32 })) }),
});

register('POST', '/v1/billing/cancel', {
  headers: object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
});
register('GET', '/v1/billing', {});
register('POST', '/v1/billing/portal', {});
register('GET', '/v1/billing/provider-status', {});
register('GET', '/v1/billing/subscriptions', {
  querystring: object({
    ...PaginationQuery.properties,
    q: Type.Optional(Type.String({ maxLength: 200 })),
    provider: Type.Optional(Type.String({ maxLength: 32 })),
    status: Type.Optional(Type.String({ maxLength: 32 })),
    planId: Type.Optional(Identifier),
    from: Type.Optional(Type.String({ maxLength: 64 })),
    to: Type.Optional(Type.String({ maxLength: 64 })),
    wallet: Type.Optional(Type.String({ maxLength: 200 })),
    invoice: Type.Optional(Type.String({ maxLength: 200 })),
  }),
});

register('POST', '/v1/auth/login', { body: object({ password: Type.String({ minLength: 1, maxLength: 500 }), mfaToken: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }) });
register('POST', '/v1/auth/mfa/confirm', { body: object({ token: Type.String({ minLength: 1, maxLength: 100 }) }) });
register('POST', '/v1/auth/mfa/verify', { body: object({ token: Type.String({ minLength: 1, maxLength: 100 }) }) });
register('POST', '/v1/auth/mfa/disable', { body: object({ token: Type.String({ minLength: 1, maxLength: 100 }) }) });
register('POST', '/v1/auth/mfa/recovery-codes', { body: object({ token: Type.String({ minLength: 1, maxLength: 100 }) }) });
register('POST', '/v1/auth/reauthenticate', { body: object({ password: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), mfaToken: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }) });
register('POST', '/v1/auth/privacy/delete', { body: object({ confirmation: Type.Literal('DELETE MY ACCOUNT') }) });
register('GET', '/v1/auth/passkeys', {});
register('POST', '/v1/auth/passkeys/options', { body: JsonObject });
register('POST', '/v1/auth/passkeys/verify', { body: Type.Record(Type.String({ minLength: 1, maxLength: 120 }), Type.Unknown()) });
register('POST', '/v1/auth/passkeys/reauth/options', {});
register('POST', '/v1/auth/passkeys/reauth/verify', { body: Type.Record(Type.String({ minLength: 1, maxLength: 120 }), Type.Unknown()) });
register('POST', '/v1/auth/passkeys/register/options', { body: JsonObject });
register('POST', '/v1/auth/passkeys/register', { body: Type.Record(Type.String({ minLength: 1, maxLength: 120 }), Type.Unknown()) });
register('DELETE', '/v1/auth/passkeys/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/artifacts', { querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }) });

register('POST', '/v1/dashboard/decrypt', {
  body: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), versionLabel: Type.Optional(Type.String({ maxLength: 64 })), preferPrimary: Type.Optional(Type.Boolean()) }),
});

register('POST', '/v1/dashboard/decrypt/preflight', {
  body: object({ bundleId: BundleId, testflight: Type.Optional(Type.Boolean()), versionLabel: Type.Optional(Type.String({ maxLength: 64 })), installSizeBytes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), deviceId: Type.Optional(Identifier) }),
});

register('POST', '/v1/dashboard/testflight/decrypt', {
  body: object({ bundleId: BundleId, appId: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Integer({ minimum: 1 })]), build: Type.Record(Type.String(), Type.Unknown()), deviceId: Type.Optional(Identifier), preferPrimary: Type.Optional(Type.Boolean()) }),
});

register('GET', '/v1/jobs/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/artifacts/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/artifacts/:id/file', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/jobs/:id/status', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/jobs/:id/timeline', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/jobs/:id/diagnostic', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/jobs/:id/cancel', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/jobs/:id/prioritize', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/jobs/:id/retry', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/notifications', { querystring: PaginationQuery });
register('GET', '/v1/dashboard/jobs', { querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), source: Type.Optional(Type.Union([Type.Literal('manual'), Type.Literal('scheduler')])), status: Type.Optional(Type.Union([Type.Literal('done'), Type.Literal('failed')])), queuedBy: Type.Optional(Type.String({ maxLength: 120 })), deviceId: Type.Optional(Identifier), errorQ: Type.Optional(Type.String({ maxLength: 200 })), failureCategory: Type.Optional(Type.String({ maxLength: 64 })), fromTs: Type.Optional(Type.Integer()), toTs: Type.Optional(Type.Integer()) }) });
register('GET', '/v1/dashboard/artifacts', { querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }) });
register('GET', '/v1/dashboard/logs', { querystring: object({ ...PaginationQuery.properties, scope: Type.Optional(Type.String({ maxLength: 100 })), level: Type.Optional(Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')])), q: Type.Optional(Type.String({ maxLength: 100 })), regex: Type.Optional(Type.Literal('1')) }) });
register('GET', '/v1/dashboard/devices/:id/activity', { params: object({ id: Identifier }), querystring: PaginationQuery });
register('GET', '/v1/dashboard/audit-log', { querystring: PaginationQuery });
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
register('GET', '/v1/dashboard/devices/:id/health', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/preflight', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/inventory', { params: object({ id: Identifier }) });
register('PUT', '/v1/dashboard/devices/:id/dark-mode', { params: object({ id: Identifier }), body: object({ enabled: Type.Boolean() }) });
register('POST', '/v1/dashboard/devices/:id/bridge-action', { params: object({ id: Identifier }), body: object({ action: Identifier }) });
register('POST', '/v1/dashboard/devices/:id/recover', { params: object({ id: Identifier }) });

register('POST', '/v1/billing/webhooks/inbox/:id/replay', { params: object({ id: Identifier }) });
register('POST', '/v1/billing/webhooks/inbox/:id/quarantine', { params: object({ id: Identifier }), body: object({ reason: Type.Optional(Type.String({ maxLength: 500 })) }) });
register('GET', '/v1/billing/webhooks/inbox', { querystring: object({ ...PaginationQuery.properties, status: Type.Optional(Type.String({ maxLength: 32 })), provider: Type.Optional(Type.String({ maxLength: 32 })) }) });

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
  ['GET', '/v1/dashboard/devices'],
  ['GET', '/v1/dashboard/github/rate-limit'],
  ['GET', '/v1/dashboard/devices/:id/health-history'],
  ['GET', '/v1/dashboard/devices/:id/battery-history'],
  ['GET', '/v1/dashboard/devices/:id/temperature-history'],
  ['GET', '/v1/dashboard/devices/:id/storage-history'],
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

register('PATCH', '/v1/auth/profile', { body: object({ displayName: Type.String({ minLength: 1, maxLength: 64 }) }) });
register('DELETE', '/v1/auth/connections/:provider', { params: object({ provider: Type.Union([Type.Literal('github'), Type.Literal('discord')]) }) });
register('POST', '/v1/dashboard/notifications/read', { body: object({ ids: Type.Optional(Type.Array(Identifier, { maxItems: 100 })) }) });
register('POST', '/v1/dashboard/jobs/bulk-preview', { body: object({ ids: Type.Array(Identifier, { maxItems: 100 }) }) });
register('POST', '/v1/dashboard/jobs/reorder', { body: object({ ids: Type.Array(Identifier, { maxItems: 100 }) }) });
register('POST', '/v1/stripe/webhook', { headers: object({ 'stripe-signature': Type.String({ minLength: 1, maxLength: 200 }) }), body: Type.Any() });
register('POST', '/v1/nowpayments/webhook', { headers: object({ 'x-nowpayments-sig': Type.String({ minLength: 1, maxLength: 500 }) }), body: Type.Any() });

register('GET', '/v1/health', { response: { 200: HealthResponse } });
register('GET', '/v1/billing', { response: { 200: BillingResponse } });
register('GET', '/v1/billing/subscriptions', { response: { 200: BillingSubscriptionPage } });
register('GET', '/v1/dashboard/overview', { response: { 200: DashboardOverviewResponse } });
register('GET', '/v1/dashboard/jobs', { response: { 200: JobHistoryPage } });
register('GET', '/v1/dashboard/artifacts', { response: { 200: ArtifactPage } });
register('GET', '/v1/dashboard/devices', { response: { 200: DeviceListResponse } });
register('GET', '/v1/dashboard/devices/:id/health', { params: object({ id: Identifier }), response: { 200: DeviceHealthResponse } });
register('GET', '/v1/dashboard/devices/:id/preflight', { params: object({ id: Identifier }), response: { 200: DevicePreflightResponse } });
register('GET', '/v1/dashboard/jobs/:id/status', { params: object({ id: Identifier }), response: { 200: JobSummaryResponse } });
register('GET', '/v1/dashboard/jobs/:id/timeline', { params: object({ id: Identifier }), response: { 200: JobTimelineResponse } });
register('GET', '/v1/dashboard/testflight/catalog', { querystring: object({ refresh: Type.Optional(Type.Literal('true')) }), response: { 200: TestFlightCatalogResponse } });
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
register('GET', '/v1/dashboard/doctor', { response: { 200: DoctorResponse } });
register('GET', '/v1/dashboard/synthetic', { response: { 200: SyntheticResponse } });
register('GET', '/v1/dashboard/notifications', { response: { 200: NotificationPage } });
register('GET', '/v1/dashboard/devices/discover', { response: { 200: DeviceDiscoveryResponse } });
register('GET', '/v1/dashboard/devices/:id/health-history', { params: object({ id: Identifier }), response: { 200: DeviceHealthHistoryResponse } });
register('GET', '/v1/dashboard/devices/:id/activity', { params: object({ id: Identifier }), querystring: PaginationQuery, response: { 200: DeviceActivityResponse } });
register('GET', '/v1/dashboard/devices/:id/battery-history', { params: object({ id: Identifier }), response: { 200: DeviceHistoryResponse } });
register('GET', '/v1/dashboard/devices/:id/temperature-history', { params: object({ id: Identifier }), response: { 200: DeviceHistoryResponse } });
register('GET', '/v1/dashboard/devices/:id/storage-history', { params: object({ id: Identifier }), response: { 200: DeviceHistoryResponse } });
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
  headers: object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
  body: object({ planId: Identifier, provider: Type.Optional(Type.Union([Type.Literal('stripe'), Type.Literal('crypto')])), cryptoAsset: Type.Optional(Type.String({ minLength: 2, maxLength: 32 })) }),
  response: { 200: BillingCheckoutResponse, 201: BillingCheckoutResponse },
});
register('POST', '/v1/billing/portal', { response: { 200: UrlResponse } });
register('POST', '/v1/billing/cancel', { headers: object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }), response: { 200: BillingCancelResponse } });
register('POST', '/v1/billing/subscription', { body: object({ planId: Identifier }), response: { 200: BillingSubscriptionUpdateResponse } });
register('GET', '/v1/dashboard/settings', { response: { 200: SchedulerSettingsResponse } });
register('PUT', '/v1/dashboard/settings', { response: { 200: SchedulerSettingsResponse } });
register('GET', '/v1/dashboard/settings/validate-cron', { response: { 200: object({ valid: Type.Boolean() }) } });
register('GET', '/v1/dashboard/users', { response: { 200: UserDirectoryResponse } });
register('GET', '/v1/dashboard/audit-log', { querystring: PaginationQuery, response: { 200: AuditLogPage } });
register('GET', '/v1/dashboard/roles', { response: { 200: RolesResponse } });
register('POST', '/v1/dashboard/roles', { response: { 201: RoleResponse } });
register('PATCH', '/v1/dashboard/roles/:id', { params: object({ id: Identifier }), response: { 200: RoleResponse } });
register('POST', '/v1/dashboard/roles/reorder', { response: { 200: RolesResponse } });
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
register('GET', '/v1/dashboard/backup/schedule', { response: { 200: BackupScheduleResponse } });
register('POST', '/v1/dashboard/backup/schedule', { response: { 200: BackupScheduleResponse } });
register('GET', '/v1/dashboard/backup/history', { response: { 200: BackupHistoryResponse } });
register('POST', '/v1/dashboard/backup/history', { response: { 200: BackupHistoryEntryResponse } });
register('POST', '/v1/dashboard/backup/import', { response: { 200: OkResponse } });
register('POST', '/v1/dashboard/backup/preview', { response: { 200: BackupPreviewResponse } });
register('POST', '/v1/dashboard/backup/drill', { response: { 200: BackupDrillResponse } });
register('DELETE', '/v1/dashboard/backup/history/:id', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/decrypts', {
  body: object({ bundleId: BundleId, version: Type.Optional(VersionSelector) }),
  response: { 200: DecryptJobResponse, 202: DecryptJobResponse },
});
register('GET', '/v1/artifacts', {
  querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }),
  response: { 200: ApiArtifactPage },
});
register('GET', '/v1/artifacts/:id', { params: object({ id: Identifier }), response: { 200: ArtifactSummaryResponse } });
register('GET', '/v1/jobs/:id', { params: object({ id: Identifier }), response: { 200: JobSummaryResponse } });
register('GET', '/v1/testflight/:appId/trains', {
  params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }),
  querystring: object({}),
  response: { 200: TestFlightTrainsResponse },
});
register('GET', '/v1/testflight/:appId/builds', {
  params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }),
  querystring: object({ trainVersion: Type.String({ minLength: 1, maxLength: 64 }) }),
  response: { 200: TestFlightBuildsResponse },
});
register('POST', '/v1/testflight/decrypt', {
  body: object({ bundleId: BundleId, appId: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Integer({ minimum: 1 })]), build: Type.Record(Type.String(), Type.Unknown()) }),
  response: { 202: JobSummaryResponse },
});
register('GET', '/v1/dashboard/artifacts', {
  querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }),
  response: { 200: DashboardArtifactPage },
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
  body: object({ bundleId: BundleId, appId: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Integer({ minimum: 1 })]), build: Type.Record(Type.String(), Type.Unknown()), deviceId: Type.Optional(Identifier), preferPrimary: Type.Optional(Type.Boolean()) }),
  response: { 202: JobSummaryResponse },
});
register('GET', '/v1/dashboard/search', {
  querystring: object({ q: Type.String({ minLength: 1, maxLength: 200 }) }),
  response: { 200: SearchResponse },
});
register('GET', '/v1/dashboard/testflight/subscriptions', {
  querystring: PaginationQuery,
  response: { 200: TestFlightSubscriptionPage },
});
register('POST', '/v1/dashboard/testflight/subscriptions', {
  body: object({ url: Type.String({ minLength: 1, maxLength: 500 }) }),
  response: { 200: TestFlightSubscriptionMutationResponse, 201: TestFlightSubscriptionMutationResponse, 202: TestFlightSubscriptionMutationResponse },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/approve', {
  params: object({ id: Identifier }),
  response: { 202: TestFlightSubscriptionMutationResponse },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/deny', {
  params: object({ id: Identifier }),
  response: { 200: TestFlightSubscriptionMutationResponse },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/sync', {
  params: object({ id: Identifier }),
  response: { 202: TestFlightSubscriptionMutationResponse },
});
register('POST', '/v1/dashboard/testflight/subscriptions/:id/unsubscribe', {
  params: object({ id: Identifier }),
  response: { 202: TestFlightSubscriptionMutationResponse },
});
register('POST', '/v1/dashboard/testflight/catalog/:bundleId/unsubscribe', {
  params: object({ bundleId: BundleId }),
  response: { 200: TestFlightDeviceUnsubscribeResponse },
});
register('POST', '/v1/dashboard/decrypt/preflight', {
  body: object({ bundleId: BundleId, testflight: Type.Optional(Type.Boolean()), versionLabel: Type.Optional(Type.String({ maxLength: 64 })), installSizeBytes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), deviceId: Type.Optional(Identifier) }),
  response: { 200: DashboardDecryptPreflightResponse },
});
register('GET', '/v1/dashboard/versions/:bundleId', {
  params: object({ bundleId: BundleId }),
  querystring: object({ force: Type.Optional(Type.Literal('true')) }),
  response: { 200: VersionsResponse },
});
register('POST', '/v1/dashboard/devices/setup', {
  body: DeviceConnectionInput,
  response: { 201: DeviceSetupResponse },
});
register('POST', '/v1/dashboard/devices', {
  body: DeviceRecordInput,
  response: { 201: DeviceResponse },
});
register('PATCH', '/v1/dashboard/devices/:id', {
  params: object({ id: Identifier }),
  body: DevicePatchInput,
  response: { 200: DeviceResponse },
});
register('GET', '/v1/dashboard/devices/:id/inventory', {
  params: object({ id: Identifier }),
  response: { 200: DeviceInventoryResponse },
});
register('PUT', '/v1/dashboard/devices/:id/dark-mode', {
  params: object({ id: Identifier }),
  body: object({ enabled: Type.Boolean() }),
  response: { 200: DeviceHealthResponse },
});
register('POST', '/v1/dashboard/devices/:id/bridge-action', {
  params: object({ id: Identifier }),
  body: object({ action: Type.Union([Type.Literal('open-testflight'), Type.Literal('open-appstore'), Type.Literal('screen-status')]) }),
  response: { 200: BridgeActionResponse },
});
register('POST', '/v1/dashboard/devices/:id/recover', {
  params: object({ id: Identifier }),
  response: { 200: OkResponse },
});
register('GET', '/v1/dashboard/jobs/export', {
  querystring: object({ format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('csv')])) }),
  response: { 200: JobExportResponse },
});
register('POST', '/v1/dashboard/jobs/bulk-preview', {
  body: object({ ids: Type.Array(Identifier, { maxItems: 100 }) }),
  response: { 200: BulkPreviewResponse },
});
register('GET', '/v1/dashboard/jobs/stats/:bundleId', {
  params: object({ bundleId: BundleId }),
  response: { 200: BundleStatsResponse },
});
register('GET', '/v1/dashboard/jobs/diff', {
  querystring: object({ bundleId: BundleId, a: Identifier, b: Identifier }),
  response: { 200: JobDiffResponse },
});
register('GET', '/v1/dashboard/insights', {
  querystring: object({ topApps: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })), trendDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })) }),
  response: { 200: InsightsResponse },
});
register('GET', '/v1/dashboard/failure-patterns', { response: { 200: FailurePatternsResponse } });
register('GET', '/v1/dashboard/storage-forecast', { response: { 200: StorageForecastResponse } });
register('GET', '/v1/dashboard/watches', { response: { 200: WatchListResponse } });
register('GET', '/v1/dashboard/watches/export', { response: { 200: WatchExportResponse } });
register('GET', '/v1/dashboard/watches/health', { response: { 200: WatchHealthResponse } });
register('GET', '/v1/dashboard/watches/calendar', {
  querystring: object({ hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })), fromAt: Type.Optional(Type.Integer()) }),
  response: { 200: WatchCalendarResponse },
});
register('GET', '/v1/dashboard/github/budget-history', {
  querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
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
  querystring: object({ retentionDays: Type.Integer({ minimum: 0 }) }),
  response: { 200: RetentionPreviewResponse },
});
register('GET', '/v1/dashboard/settings/validate-cron', {
  querystring: object({ expr: Type.String({ maxLength: 100 }) }),
  response: { 200: object({ valid: Type.Boolean() }) },
});
register('POST', '/v1/dashboard/settings/test-webhook', {
  body: object({ url: Type.Optional(Type.String({ maxLength: 500 })) }),
  response: { 200: TestWebhookResponse, 400: TestWebhookResponse },
});
register('POST', '/v1/dashboard/notifications/read', {
  body: object({ ids: Type.Optional(Type.Array(Identifier, { maxItems: 100 })) }),
  response: { 200: object({ ok: Type.Boolean(), marked: Type.Integer({ minimum: 0 }) }) },
});
register('POST', '/v1/dashboard/jobs/:id/cancel', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/dashboard/jobs/:id/prioritize', { params: object({ id: Identifier }), response: { 200: OkResponse } });
register('POST', '/v1/dashboard/jobs/:id/retry', { params: object({ id: Identifier }), response: { 202: JobSummaryResponse } });
register('POST', '/v1/dashboard/jobs/reorder', {
  body: object({ ids: Type.Array(Identifier, { maxItems: 100 }) }),
  response: { 200: OkResponse },
});
register('GET', '/v1/dashboard/logs', {
  querystring: object({ ...PaginationQuery.properties, scope: Type.Optional(Type.String({ maxLength: 100 })), level: Type.Optional(Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')])), q: Type.Optional(Type.String({ maxLength: 100 })), regex: Type.Optional(Type.Literal('1')) }),
  response: { 200: LogsPageResponse },
});
register('GET', '/v1/dashboard/webhooks', {
  querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
  response: { 200: WebhookDeliveryPageResponse },
});
register('GET', '/v1/dashboard/events', {
  response: { 200: Type.String() },
});
register('GET', '/v1/dashboard/jobs/:id/diagnostic', {
  params: object({ id: Identifier }),
  response: { 200: DiagnosticResponse },
});
register('GET', '/v1/dashboard/support-bundle', {
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
  querystring: object({ format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('csv')])) }),
  response: { 200: JobExportResponse },
});
register('GET', '/v1/dashboard/watches/export', {
  response: { 200: WatchExportResponse },
});
register('GET', '/v1/dashboard/backup/export', {
  response: { 200: BackupExportResponse },
});
register('GET', '/v1/dashboard/backup/history/:id/download', {
  params: object({ id: Identifier }),
  response: { 200: Type.String() },
});
register('POST', '/v1/dashboard/backup/import', {
  body: JsonObject,
  response: { 200: OkResponse },
});
register('POST', '/v1/dashboard/backup/preview', {
  body: JsonObject,
  response: { 200: BackupPreviewResponse },
});
register('POST', '/v1/dashboard/backup/drill', {
  body: JsonObject,
  response: { 200: BackupDrillResponse },
});
register('DELETE', '/v1/dashboard/backup/history/:id', {
  params: object({ id: Identifier }),
  response: { 200: OkResponse },
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
  response: { 200: UserPrefsResponse },
});
register('PUT', '/v1/dashboard/me/prefs', {
  body: Type.Partial(UserPrefsResponse),
  response: { 200: UserPrefsResponse },
});
register('GET', '/v1/dashboard/push/public-key', {
  response: { 200: PushKeyResponse },
});
register('POST', '/v1/dashboard/push/subscribe', {
  body: object({ endpoint: Type.String({ minLength: 1, maxLength: 2000 }), keys: object({ p256dh: Type.String({ minLength: 1 }), auth: Type.String({ minLength: 1 }) }) }),
  response: { 200: OkResponse },
});
register('POST', '/v1/dashboard/push/unsubscribe', {
  body: object({ endpoint: Type.String({ minLength: 1, maxLength: 2000 }) }),
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
  response: { 200: Type.String() },
});
register('GET', '/v1/decrypt', {
  querystring: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), version: Type.Optional(VersionSelector) }),
  response: { 200: BinaryFileResponse, 202: JobSummaryResponse, 500: JobSummaryResponse },
});
register('POST', '/v1/dashboard/decrypt', {
  body: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), versionLabel: Type.Optional(Type.String({ maxLength: 64 })), preferPrimary: Type.Optional(Type.Boolean()) }),
  response: { 202: JobSummaryResponse },
});
register('GET', '/v1/artifacts/:id/file', {
  params: object({ id: Identifier }),
  response: { 200: BinaryFileResponse },
});
register('GET', '/v1/dashboard/artifacts/:id/file', {
  params: object({ id: Identifier }),
  response: { 200: BinaryFileResponse },
});
register('DELETE', '/v1/dashboard/devices/:id', {
  params: object({ id: Identifier }),
  response: { 200: OkResponse },
});
register('DELETE', '/v1/dashboard/roles/:id', {
  params: object({ id: Identifier }),
  response: { 200: OkResponse },
});
register('POST', '/v1/billing/webhooks/inbox/:id/replay', {
  params: object({ id: Identifier }),
  response: { 200: WebhookReplayResponse },
});
register('POST', '/v1/billing/webhooks/inbox/:id/quarantine', {
  params: object({ id: Identifier }),
  body: object({ reason: Type.Optional(Type.String({ maxLength: 500 })) }),
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
