import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Response } from '#http.js';
import type { ArtifactRecord } from '#artifacts.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardArtifactRoutes } from '#routes/dashboardArtifactRoutes.js';
import { setSessionCookie } from '#session.js';

function sessionCookie(permissions = 0n): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'artifact-1',
    key: 'com.example.app|appstore|1.0',
    projectIds: ['default'],
    bundleId: 'com.example.app',
    channel: 'appstore',
    filePath: '/tmp/app.ipa',
    fileSizeBytes: 4,
    sha256: 'a'.repeat(64),
    createdAt: 1,
    lastAccessedAt: 2,
    accessCount: 3,
    ...overrides,
  };
}

test('artifact listing and pinning use native dashboard routes', async () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/artifacts');
  expect(routes).not.toContain('PUT /v1/dashboard/artifacts/:id/pin');
  expect(routes).not.toContain('GET /v1/dashboard/artifacts/:id/file');

  const record = artifact({ pinnedAt: 3, sourceJobId: 'job-1', warnings: ['extension remains encrypted'] });
  const listCalls: unknown[] = [];
  const audits: Array<[string, string, string, string?]> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardArtifactRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    listArtifacts: (options) => {
      listCalls.push(options);
      return { artifacts: [record], total: 1, totalBytes: 4, maxBytes: 10, nextCursor: 'next-page' };
    },
    artifactFileAvailable: () => true,
    getArtifactById: () => record,
    setArtifactPinned: async (_id, pinned) => ({ artifact: artifact({ ...record, pinnedAt: pinned ? 4 : undefined }), changed: true }),
    recordAudit: (...entry) => { audits.push(entry); },
  }));

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.requestDecrypt | PermissionFlag.manageAutomation) };
    const listed = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/artifacts?projectId=default&limit=5&offset=2&q=example&channel=appstore',
      headers,
    });
    const pinned = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/artifacts/artifact-1/pin',
      headers,
      payload: { pinned: true },
    });

    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body)).toEqual({
      artifacts: [{
        ...record,
        filePath: undefined,
        fileUrl: '/v1/dashboard/artifacts/artifact-1/file',
        createdAt: '1970-01-01T00:00:00.001Z',
        lastAccessedAt: '1970-01-01T00:00:00.002Z',
        pinnedAt: '1970-01-01T00:00:00.003Z',
      }],
      total: 1,
      totalBytes: 4,
      maxBytes: 10,
      nextCursor: 'next-page',
    });
    expect(listCalls).toEqual([{
      offset: 2,
      limit: 5,
      cursor: undefined,
      query: 'example',
      channel: 'appstore',
      projectIds: ['default'],
    }]);
    expect(pinned.statusCode).toBe(200);
    expect(JSON.parse(pinned.body)).toEqual({ ok: true, artifactId: 'artifact-1', pinned: true, pinnedAt: '1970-01-01T00:00:00.004Z' });
    expect(audits).toEqual([['root', 'artifact.pin', 'artifact-1']]);
  } finally {
    await server.close();
  }
});

test('artifact listing and pinning keep their permission and project boundaries', async () => {
  const record = artifact({ projectIds: ['private'] });
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardArtifactRoutes({
    canAccessProject: (_userId, _permissions, projectId) => projectId === 'default',
    artifactFileAvailable: () => true,
    getArtifactById: () => record,
  }));

  try {
    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts' });
    const missingDecryptPermission = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts', headers: { cookie: sessionCookie() } });
    const inaccessibleProject = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/artifacts?projectId=private',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
    });
    const missingPinPermission = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/artifacts/artifact-1/pin',
      headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) },
      payload: { pinned: true },
    });
    const inaccessibleArtifact = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/artifacts/artifact-1/pin',
      headers: { cookie: sessionCookie(PermissionFlag.manageAutomation) },
      payload: { pinned: true },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(missingDecryptPermission.statusCode).toBe(403);
    expect(inaccessibleProject.statusCode).toBe(404);
    expect(missingPinPermission.statusCode).toBe(403);
    expect(inaccessibleArtifact.statusCode).toBe(404);
  } finally {
    await server.close();
  }
});
