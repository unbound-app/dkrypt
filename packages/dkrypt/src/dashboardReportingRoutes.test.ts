import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { getRouteContract } from '#contracts.js';
import type { Response } from '#http.js';
import type { LogEntry } from '#logger.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardReportingRoutes } from '#routes/dashboardReportingRoutes.js';
import { setSessionCookie } from '#session.js';
import type { AppWatch, DeviceRecord, InsightsSummary, JobHistoryEntry, SchedulerRunEntry, WatchHealthSummary, WebhookDeliveryEntry } from '#store/state.js';

function sessionCookie(permissions = 0n): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

test('insights is served through the typed dashboard API and preserves bounded query behavior', async () => {
  const summary: InsightsSummary = {
    totalRuns: 3,
    doneCount: 2,
    failedCount: 1,
    successRate: 2 / 3,
    totalSizeBytes: 4096,
    manualCount: 2,
    schedulerCount: 1,
    topApps: [{ bundleId: 'com.example.app', totalRuns: 3, doneCount: 2, failedCount: 1, successRate: 2 / 3, totalSizeBytes: 4096 }],
    trend: [{ date: '2026-09-26', count: 3 }],
    failureBreakdown: [{ category: 'device_transport', count: 1 }],
    byDevice: [],
    anomalies: [],
  };
  const calls: Array<[number, number, string | undefined]> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardReportingRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    getInsightsSummary: (topApps, trendDays, projectId) => {
      calls.push([topApps, trendDays, projectId]);
      return summary;
    },
  }));

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/insights?topApps=invalid&trendDays=999&projectId=default',
      headers: { cookie: sessionCookie() },
    });
    const deniedProject = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/insights?projectId=private',
      headers: { cookie: sessionCookie() },
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(summary);
    expect(calls).toEqual([[5, 90, 'default']]);
    expect(deniedProject.statusCode).toBe(404);
    expect(getRouteContract('GET', '/v1/dashboard/insights')).toHaveProperty('response.200.properties.topApps.items.properties.bundleId');
    expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/insights');
  } finally {
    await server.close();
  }
});

test('failure patterns remain permission-gated, project-scoped, and redact volatile secrets', async () => {
  const now = Date.now();
  const history: JobHistoryEntry[] = [
    {
      id: 'failed-1',
      projectId: 'default',
      bundleId: 'com.example.first',
      status: 'failed',
      source: 'manual',
      createdAt: now - 20,
      finishedAt: now - 10,
      error: 'install failed at https://one.example/path token=first 123456',
    },
    {
      id: 'failed-2',
      projectId: 'default',
      bundleId: 'com.example.second',
      status: 'failed',
      source: 'manual',
      createdAt: now - 8,
      finishedAt: now,
      error: 'install failed at https://two.example/path token=second 987654',
    },
    {
      id: 'foreign-failure',
      projectId: 'private',
      bundleId: 'com.example.private',
      status: 'failed',
      source: 'manual',
      createdAt: now - 3,
      finishedAt: now - 2,
      error: 'private project failure',
    },
  ];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardReportingRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    getAllJobHistory: () => history,
  }));

  try {
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/failure-patterns?projectId=default', headers: { cookie: sessionCookie() } });
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/failure-patterns?projectId=default',
      headers: { cookie: sessionCookie(PermissionFlag.viewAutomation) },
    });

    expect(denied.statusCode).toBe(403);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      patterns: [{
        message: 'install failed at [url] [redacted] [number]',
        count: 2,
        firstSeen: now - 10,
        lastSeen: now,
        bundleIds: ['com.example.first', 'com.example.second'],
      }],
    });
    expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/failure-patterns');
  } finally {
    await server.close();
  }
});

test('storage forecast uses thirty-day project history and reports unavailable storage', async () => {
  const now = Date.now();
  const history: JobHistoryEntry[] = [
    {
      id: 'completed-1',
      projectId: 'default',
      bundleId: 'com.example.app',
      status: 'done',
      source: 'manual',
      createdAt: now - 86_400_000,
      finishedAt: now - 86_400_000,
      sizeBytes: 30_000,
    },
    {
      id: 'old-completed',
      projectId: 'default',
      bundleId: 'com.example.app',
      status: 'done',
      source: 'manual',
      createdAt: now - 31 * 86_400_000,
      finishedAt: now - 31 * 86_400_000,
      sizeBytes: 90_000,
    },
    {
      id: 'foreign-completed',
      projectId: 'private',
      bundleId: 'com.example.app',
      status: 'done',
      source: 'manual',
      createdAt: now - 86_400_000,
      finishedAt: now - 86_400_000,
      sizeBytes: 60_000,
    },
  ];
  let diskReads = 0;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardReportingRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    getAllJobHistory: () => history,
    getDiskUsage: () => ++diskReads === 1 ? { totalBytes: 100_000, freeBytes: 30_000, usedBytes: 70_000, usedPercent: 0.7 } : undefined,
  }));

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.viewAutomation) };
    const response = await server.inject({ method: 'GET', url: '/v1/dashboard/storage-forecast?projectId=default', headers });
    const unavailable = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/storage-forecast?projectId=default',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ freeBytes: 30_000, bytesPerDay: 1_000, daysRemaining: 30, sampleCount: 1 });
    expect(unavailable.statusCode).toBe(503);
    expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/storage-forecast');
  } finally {
    await server.close();
  }
});

test('webhook delivery history remains log-permission gated and clamps the requested limit', async () => {
  const deliveries: WebhookDeliveryEntry[] = [{
    id: 'delivery-1',
    ts: 123,
    kind: 'scheduler',
    event: 'dispatch.completed',
    targetHost: 'hooks.example.com',
    ok: true,
    status: 204,
    durationMs: 45,
  }];
  const limits: number[] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardReportingRoutes({
    getWebhookDeliveryLog: (limit = 100) => {
      limits.push(limit);
      return deliveries;
    },
  }));

  try {
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/webhooks', headers: { cookie: sessionCookie() } });
    const fallbackLimit = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/webhooks?limit=invalid',
      headers: { cookie: sessionCookie(PermissionFlag.viewLogs) },
    });
    const maximumLimit = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/webhooks?limit=500',
      headers: { cookie: sessionCookie(PermissionFlag.viewLogs) },
    });

    expect(denied.statusCode).toBe(403);
    expect(fallbackLimit.statusCode).toBe(200);
    expect(maximumLimit.statusCode).toBe(200);
    expect(JSON.parse(maximumLimit.body)).toEqual({ deliveries });
    expect(limits).toEqual([100, 200]);
    expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/webhooks');
  } finally {
    await server.close();
  }
});

test('support bundles require management permission and redact sensitive diagnostic data', async () => {
  const watch: AppWatch = {
    id: 'watch-1',
    bundleId: 'com.example.app',
    repo: 'example/app',
    ghWorkflowFile: 'decrypt.yml',
    pollCron: '0 * * * *',
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
  };
  const device: DeviceRecord = { id: 'ipad-1', name: 'iPad', enabled: true, isPrimary: true, createdAt: 1, updatedAt: 2 };
  const privateWatch: AppWatch = { ...watch, id: 'private-watch', projectId: 'private', bundleId: 'com.example.private' };
  const job: JobHistoryEntry = {
    id: 'failed-job',
    correlationId: 'correlation-job-1',
    projectId: 'default',
    bundleId: 'com.example.app',
    status: 'failed',
    source: 'manual',
    createdAt: 1,
    finishedAt: 2,
    error: 'Authorization: Bearer job-token password=job-password access_token=job-access at https://private.example/path',
  };
  const privateJob: JobHistoryEntry = { ...job, id: 'private-job', projectId: 'private', bundleId: 'com.example.private' };
  const run: SchedulerRunEntry = {
    id: 'run-1',
    ts: 2,
    watchId: 'watch-1',
    bundleId: 'com.example.app',
    appStore: { ok: false, triggered: false, reason: 'Authorization: Bearer scheduler-token' },
    testflight: { ok: true, triggered: false, reason: 'https://private.example/path' },
  };
  const privateRun: SchedulerRunEntry = { ...run, id: 'private-run', watchId: 'private-watch', bundleId: 'com.example.private' };
  const health: WatchHealthSummary[] = [
    { watchId: 'watch-1', bundleId: 'com.example.app', schedulable: true, dispatchTargetCount: 0, consecutiveFailures: 0, everTriggeredInHistory: false, historyCount: 0, schedulerJobCount: 0 },
    { watchId: 'private-watch', bundleId: 'com.example.private', schedulable: true, dispatchTargetCount: 0, consecutiveFailures: 0, everTriggeredInHistory: false, historyCount: 0, schedulerJobCount: 0 },
  ];
  const log: LogEntry = {
    id: 'log-1',
    ts: 3,
    level: 'error',
    scope: 'scheduler',
    message: 'Authorization: Bearer log-token password=log-password access_token=log-access at https://private.example/path',
    meta: { projectId: 'default', authorization: 'Bearer metadata-token', password: 'private-value', token: 'private-value', access_token: 'metadata-access' },
  };
  const privateLog: LogEntry = { ...log, id: 'private-log', meta: { projectId: 'private' } };
  const transportLog: LogEntry = {
    id: 'transport-log',
    ts: 4,
    level: 'warn',
    scope: 'idevice',
    message: 'USB reconnect completed',
    meta: { projectId: 'default', deviceId: 'ipad-1', operation: 'reconnect', correlationId: 'correlation-transport-1' },
  };
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardReportingRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    getAllJobHistory: () => [job, privateJob],
    getStateDatabaseStatus: () => ({ path: '/state/dkrypt.sqlite', schemaVersion: 14, integrity: 'ok' }),
    verifyLatestDatabaseBackup: () => ({ ok: true, detail: 'verified' }),
    getDiskUsage: () => ({ totalBytes: 100, freeBytes: 50, usedBytes: 50, usedPercent: 0.5 }),
    getAppCatalogStats: () => ({ entries: 1, icons: 1 }),
    getEffectiveDevices: () => [device],
    getEffectiveWatches: () => [watch, privateWatch],
    getWatchDispatchTargets: () => [],
    getWatchHealthRollup: () => health,
    getSchedulerRunHistory: () => [run, privateRun],
    getRecentLogs: (query) => ({ logs: [log, privateLog, transportLog].filter((entry) => query?.filter?.(entry)), total: 3 }),
  }));

  try {
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/support-bundle?projectId=default', headers: { cookie: sessionCookie(PermissionFlag.viewAutomation) } });
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/support-bundle?projectId=default',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
    });
    const bundle = JSON.parse(response.body);

    expect(denied.statusCode).toBe(403);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toBe('attachment; filename="dkrypt-support-bundle.json"');
    expect(bundle.devices).toEqual([{ id: 'ipad-1', name: 'iPad', enabled: true, isPrimary: true }]);
    expect(bundle.watches).toEqual([{ bundleId: 'com.example.app', enabled: true, pollCron: '0 * * * *', destinations: 0 }]);
    expect(bundle.watchHealth).toHaveLength(1);
    expect(bundle.schedulerRuns).toHaveLength(1);
    expect(bundle.logs).toHaveLength(2);
    expect(bundle.jobs).toHaveLength(1);
    expect(bundle.logs.find((entry: LogEntry) => entry.id === 'log-1')).toMatchObject({
      message: 'Authorization: Bearer [redacted] password=[redacted] access_token=[redacted] at [redacted-url]',
      meta: { authorization: '[redacted]', password: '[redacted]', token: '[redacted]', access_token: '[redacted]' },
    });
    expect(bundle.transportTimeline).toEqual([{
      id: 'transport-log',
      at: 4,
      level: 'warn',
      message: 'USB reconnect completed',
      deviceId: 'ipad-1',
      operation: 'reconnect',
      correlationId: 'correlation-transport-1',
    }]);
    expect(bundle.correlationIds).toEqual(['correlation-job-1', 'correlation-transport-1']);
    expect(bundle.schedulerRuns[0].appStore.reason).toBe('Authorization: Bearer [redacted]');
    expect(bundle.schedulerRuns[0].testflight.reason).toBe('[redacted-url]');
    expect(bundle.jobs[0].error).toBe('Authorization: Bearer [redacted] password=[redacted] access_token=[redacted] at [redacted-url]');
    expect(dashboardRouter.routes.map((route) => `${route.method} ${route.path}`)).not.toContain('GET /v1/dashboard/support-bundle');
  } finally {
    await server.close();
  }
});
