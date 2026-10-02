import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Response } from '#http.js';
import { PermissionFlag } from '#permissions.js';
import { createDashboardQuickSearchRoutes } from '#routes/dashboardQuickSearchRoutes.js';
import { setSessionCookie } from '#session.js';
import type { AppCatalogEntry, JobHistoryEntry, ProjectRecord } from '#store/state.js';
import { buildTestServer } from '#testServer.js';

function sessionCookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

function historyEntry(id: string, projectId: string): JobHistoryEntry {
  return {
    id,
    projectId,
    bundleId: 'com.example.app',
    versionLabel: '4.2',
    status: 'done',
    source: 'manual',
    createdAt: 1,
    finishedAt: 2,
  };
}

const project: ProjectRecord = {
  id: 'alpha',
  name: 'Alpha project',
  memberIds: ['root'],
  isDefault: false,
  createdBy: 'root',
  createdAt: 1,
  updatedAt: 1,
};

const app: AppCatalogEntry = {
  bundleId: 'com.example.app',
  displayName: 'Example App',
  updatedAt: 1,
};

test('quick search is session-only, bounded, cached, and project-scoped', async () => {
  let catalogSearches = 0;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardQuickSearchRoutes({
    canAccessProject: () => true,
    getProject: (id) => id === 'alpha' ? project : id === 'default' ? { ...project, id: 'default', isDefault: true } : undefined,
    searchAppCatalogEntries: (query, limit) => {
      catalogSearches += 1;
      expect(query).toBe('example');
      expect(limit).toBe(8);
      return [app];
    },
    getAllJobHistory: () => [historyEntry('job-alpha', 'alpha'), historyEntry('job-beta', 'beta')],
    getActiveJobs: () => [],
    listArtifacts: () => ({ artifacts: [], total: 0, totalBytes: 0, maxBytes: 1 }),
    getEffectiveDevices: () => [],
    listWatches: () => [],
    listAuthProfiles: () => [],
    listAllowedUsers: () => [],
  }));

  try {
    const url = '/v1/dashboard/quick-search?q=example&projectId=alpha';
    const anonymous = await server.inject({ method: 'GET', url });
    const keyOnly = await server.inject({ method: 'GET', url, headers: { authorization: 'Bearer dk_test_key' } });
    const response = await server.inject({
      method: 'GET',
      url,
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewLogs) },
    });
    const empty = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/quick-search?q=%20%20&projectId=alpha',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.viewLogs) },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(keyOnly.statusCode).toBe(401);
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([
      { kind: 'app', id: 'com.example.app', title: 'Example App', subtitle: 'com.example.app' },
      { kind: 'job', id: 'job-alpha', title: 'Example App', subtitle: '4.2 · done · Alpha project', projectId: 'alpha' },
    ]);
    expect(response.body).not.toContain('job-beta');
    expect(empty.json() as unknown).toEqual({ results: [] });
    expect(catalogSearches).toBe(1);
  } finally {
    await server.close();
  }
});

test('quick search hides devices, users, and settings without their permissions', async () => {
  let deviceLookups = 0;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardQuickSearchRoutes({
    getProject: () => project,
    canAccessProject: () => true,
    searchAppCatalogEntries: () => [],
    getAllJobHistory: () => [],
    getActiveJobs: () => [],
    listArtifacts: () => ({ artifacts: [], total: 0, totalBytes: 0, maxBytes: 1 }),
    getEffectiveDevices: () => {
      deviceLookups += 1;
      return [{ id: 'device-1', name: 'Example iPad', transport: 'usb', enabled: true, createdAt: 1, updatedAt: 1 }];
    },
    listWatches: () => [],
    listAuthProfiles: () => [],
    listAllowedUsers: () => [],
  }));

  try {
    const url = '/v1/dashboard/quick-search?q=example&projectId=alpha';
    const viewer = await server.inject({ method: 'GET', url, headers: { cookie: sessionCookie(0n) } });
    const deviceManager = await server.inject({ method: 'GET', url: '/v1/dashboard/quick-search?q=iPad&projectId=alpha', headers: { cookie: sessionCookie(PermissionFlag.viewDevices) } });
    const settingsManager = await server.inject({ method: 'GET', url: '/v1/dashboard/quick-search?q=devices&projectId=alpha', headers: { cookie: sessionCookie(PermissionFlag.manageDevices) } });

    expect(viewer.json().results).toEqual([]);
    expect(deviceManager.json().results).toContainEqual({ kind: 'device', id: 'device-1', title: 'Example iPad', subtitle: 'USB' });
    expect(settingsManager.json().results).toContainEqual({ kind: 'settings', id: 'devices', title: 'Devices', subtitle: 'Settings' });
    expect(deviceLookups).toBe(2);
  } finally {
    await server.close();
  }
});

test('quick search stays out of the generated API reference', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as { paths?: Record<string, unknown> };
    expect(document.paths?.['/v1/dashboard/quick-search']).toBeUndefined();
  } finally {
    await server.close();
  }
});
