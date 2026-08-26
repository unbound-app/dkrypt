import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { buildArtifactFileUrl, promoteArtifact } from '#artifacts.js';
import { upsertAuthProfile } from '#identity.js';
import { buildServer } from '#server.js';
import { createApiKey, recordJobHistory, recordNotification, revokeApiKey } from '#store/state.js';

async function signIn() {
  const server = await buildServer({ includePublicRoutes: false });
  const login = await server.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { password: process.env.ADMIN_PASSWORD },
  });
  const cookie = login.headers['set-cookie'];
  const value = Array.isArray(cookie) ? cookie[0] : cookie;
  if (typeof value !== 'string') throw new Error('login did not set a session cookie');
  return { server, cookie: value.split(';', 1)[0] };
}

test('Fastify persists dashboard device mutations and returns the updated overview', async () => {
  const { server, cookie } = await signIn();
  const rootDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-'));
  await writeFile(
    path.join(rootDir, 'config.json'),
    JSON.stringify({ device: { host: '127.0.0.1', port: 22, user: 'root', auth: { keyPath: '/tmp/test-key' } } }),
  );

  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices',
      headers: { cookie },
      payload: { name: 'test device', rootDir },
    });
    expect(created.statusCode).toBe(201);
    const device = created.json() as { id: string; name: string };
    expect(device.name).toBe('test device');

    const overview = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie } });
    expect(overview.statusCode).toBe(200);
    expect((overview.json() as { devices: { id: string }[] }).devices.some((candidate) => candidate.id === device.id)).toBe(true);

    const deleted = await server.inject({ method: 'DELETE', url: `/v1/dashboard/devices/${device.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
  } finally {
    await server.close();
  }
});

test('Fastify sends the initial dashboard overview over SSE', async () => {
  const { server, cookie } = await signIn();
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const response = await fetch(`${baseUrl}/v1/dashboard/events`, { headers: { cookie }, signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const chunk = await response.body?.getReader().read();
    expect(new TextDecoder().decode(chunk?.value)).toContain('event: overview');
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await server.close();
  }
});

test('Fastify serves browser identity assets from the public root', async () => {
  const server = await buildServer();

  try {
    const favicon = await server.inject({ method: 'GET', url: '/favicon.svg' });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers['content-type']).toContain('image/svg+xml');

    const png = await server.inject({ method: 'GET', url: '/favicon.png' });
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');

    const manifest = await server.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/manifest+json');
  } finally {
    await server.close();
  }
});

test('Fastify includes a session-protected artifact download in live history events', async () => {
  const { server, cookie } = await signIn();
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const id = `live-history-${crypto.randomUUID()}`;
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-live-history-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'ipa');
  const artifact = await promoteArtifact({
    key: `com.example.live-history|appstore|${id}`,
    bundleId: 'com.example.live-history',
    channel: 'appstore',
    versionLabel: '342.0',
    stagingPath: outputPath,
    sourceJobId: id,
  });

  try {
    const response = await fetch(`${baseUrl}/v1/dashboard/events`, { headers: { cookie }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('dashboard event stream has no reader');
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain('event: overview');

    recordJobHistory({
      id,
      bundleId: 'com.example.live-history',
      status: 'done',
      source: 'scheduler',
      artifactId: artifact.id,
      createdAt: Date.now() - 1_000,
      finishedAt: Date.now(),
    });

    const next = await reader.read();
    const text = new TextDecoder().decode(next.value);
    const match = text.match(/event: history\ndata: (.+)\n\n/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? '')).toMatchObject({
      id,
      downloadUrl: `/v1/dashboard/artifacts/${artifact.id}/file`,
      fileAvailable: true,
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await rm(artifact.filePath, { force: true });
    await server.close();
  }
});

test('Fastify has no former share-link dashboard routes', async () => {
  const { server, cookie } = await signIn();

  try {
    const routes = [
      ['POST', '/v1/dashboard/jobs/removed/share'],
      ['GET', '/v1/dashboard/jobs/removed/share'],
      ['GET', '/v1/dashboard/share-links'],
      ['GET', '/v1/dashboard/share-links/export'],
      ['POST', '/v1/dashboard/jobs/share/removed/revoke'],
      ['POST', '/v1/dashboard/jobs/removed/share/revoke-all'],
      ['PATCH', '/v1/dashboard/jobs/share/removed'],
      ['GET', '/v1/dashboard/jobs/removed/file'],
    ] as const;
    for (const [method, url] of routes) {
      const response = await server.inject({ method, url, headers: { cookie } });
      expect(response.statusCode).toBe(404);
    }
  } finally {
    await server.close();
  }
});

test('Fastify serves artifacts through a dashboard session', async () => {
  const { server, cookie } = await signIn();
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-dashboard-artifact-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'dashboard ipa');
  const artifact = await promoteArtifact({
    key: `com.example.dashboard-artifact|appstore|${crypto.randomUUID()}`,
    bundleId: 'com.example.dashboard-artifact',
    channel: 'appstore',
    versionLabel: '342.0',
    stagingPath: outputPath,
  });

  try {
    const unauthorized = await server.inject({ method: 'GET', url: `/v1/dashboard/artifacts/${artifact.id}/file` });
    expect(unauthorized.statusCode).toBe(401);

    const response = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/artifacts/${artifact.id}/file`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('dashboard ipa');
  } finally {
    await rm(artifact.filePath, { force: true });
    await server.close();
  }
});

test('Fastify marks cleaned completed jobs as unavailable in history', async () => {
  const { server, cookie } = await signIn();
  const id = `cleaned-history-${crypto.randomUUID()}`;
  recordJobHistory({
    id,
    bundleId: 'com.example.cleaned-history',
    status: 'done',
    source: 'manual',
    createdAt: Date.now() - 1_000,
    finishedAt: Date.now(),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs?q=com.example.cleaned-history',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { history: Array<{ id: string; fileAvailable: boolean }> };
    expect(body.history).toContainEqual(expect.objectContaining({ id, fileAvailable: false }));
  } finally {
    await server.close();
  }
});

test('Fastify resolves job requester identities for history', async () => {
  const { server, cookie } = await signIn();
  const suffix = crypto.randomUUID();
  const bundleId = `com.example.requester-${suffix}`;
  const userId = `github:${suffix}`;
  const manualId = `manual-requester-${suffix}`;
  const schedulerId = `scheduler-requester-${suffix}`;
  upsertAuthProfile({
    userId,
    provider: 'github',
    providerId: suffix,
    username: `requester-${suffix}`,
    displayName: 'Visual User',
    avatarUrl: 'https://example.com/avatar.png',
    updatedAt: new Date().toISOString(),
  });
  recordJobHistory({
    id: manualId,
    bundleId,
    queuedBy: userId,
    status: 'done',
    source: 'manual',
    createdAt: Date.now() - 2_000,
    finishedAt: Date.now() - 1_000,
  });
  recordJobHistory({
    id: schedulerId,
    bundleId,
    status: 'done',
    source: 'scheduler',
    createdAt: Date.now() - 1_000,
    finishedAt: Date.now(),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/jobs?q=${encodeURIComponent(bundleId)}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { history: Array<{ id: string; requester?: { username?: string; displayName: string; avatarUrl?: string } }> };
    expect(body.history.find((entry) => entry.id === manualId)?.requester).toEqual({
      username: `requester-${suffix}`,
      displayName: 'Visual User',
      avatarUrl: 'https://example.com/avatar.png',
    });
    expect(body.history.find((entry) => entry.id === schedulerId)?.requester).toEqual({
      displayName: 'System',
      avatarUrl: '/favicon.svg',
    });
  } finally {
    await server.close();
  }
});

test('Fastify exposes scheduler artifacts in recent jobs after the job is pruned', async () => {
  const { server, cookie } = await signIn();
  const id = `scheduler-artifact-${crypto.randomUUID()}`;
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-scheduler-artifact-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'ipa');
  const artifact = await promoteArtifact({
    key: `com.example.scheduler-artifact|appstore|${id}`,
    bundleId: 'com.example.scheduler-artifact',
    channel: 'appstore',
    versionLabel: '342.0',
    stagingPath: outputPath,
    sourceJobId: id,
  });
  recordJobHistory({
    id,
    bundleId: 'com.example.scheduler-artifact',
    status: 'done',
    source: 'scheduler',
    createdAt: Date.now() - 1_000,
    finishedAt: Date.now(),
  });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs?q=com.example.scheduler-artifact',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { history: Array<{ id: string; downloadUrl?: string; fileAvailable: boolean }> };
    expect(body.history.find((entry) => entry.id === id)).toMatchObject({
      downloadUrl: `/v1/dashboard/artifacts/${artifact.id}/file`,
      fileAvailable: true,
    });
  } finally {
    await rm(artifact.filePath, { force: true });
    await server.close();
  }
});

test('Fastify requires an API key for stable artifact downloads and rejects old signed tokens', async () => {
  const server = await buildServer({ includePublicRoutes: false });
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-download-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'ipa');
  const artifact = await promoteArtifact({
    key: `com.example.scheduler-download|appstore|${crypto.randomUUID()}`,
    bundleId: 'com.example.scheduler-download',
    channel: 'appstore',
    versionLabel: '342.0',
    stagingPath: outputPath,
  });

  try {
    const unauthorized = await server.inject({
      method: 'GET',
      url: `/v1/artifacts/${artifact.id}/file?token=old-token`,
    });
    expect(unauthorized.statusCode).toBe(401);

    const oldJobRoute = await server.inject({
      method: 'GET',
      url: '/v1/jobs/removed/file?token=old-token',
      headers: { authorization: `Bearer ${process.env.API_KEY}` },
    });
    expect(oldJobRoute.statusCode).toBe(404);

    const response = await server.inject({
      method: 'GET',
      url: buildArtifactFileUrl(artifact.id),
      headers: { authorization: `Bearer ${process.env.API_KEY}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('ipa');

    await rm(artifact.filePath, { force: true });
    const removed = await server.inject({
      method: 'GET',
      url: buildArtifactFileUrl(artifact.id),
      headers: { authorization: `Bearer ${process.env.API_KEY}` },
    });
    expect(removed.statusCode).toBe(404);
  } finally {
    await rm(artifact.filePath, { force: true });
    await server.close();
  }
});

test('Fastify enforces API key bundle scopes for artifact downloads', async () => {
  const server = await buildServer({ includePublicRoutes: false });
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-scoped-artifact-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'scoped ipa');
  const artifact = await promoteArtifact({
    key: `com.example.scoped-artifact|appstore|${crypto.randomUUID()}`,
    bundleId: 'com.example.scoped-artifact',
    channel: 'appstore',
    versionLabel: '342.0',
    stagingPath: outputPath,
  });
  const scopedKey = createApiKey('scoped artifact test', 'root', undefined, ['com.example.other']);

  try {
    const response = await server.inject({
      method: 'GET',
      url: buildArtifactFileUrl(artifact.id),
      headers: { authorization: `Bearer ${scopedKey.key}` },
    });
    expect(response.statusCode).toBe(403);
  } finally {
    revokeApiKey(scopedKey.id, 'root', true);
    await rm(artifact.filePath, { force: true });
    await server.close();
  }
});

test('Fastify previews retention and reports queue service objectives', async () => {
  const { server, cookie } = await signIn();

  try {
    const retention = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/settings/job-history-retention/preview?retentionDays=0',
      headers: { cookie },
    });
    expect(retention.statusCode).toBe(200);
    expect(retention.json()).toMatchObject({ retentionDays: 0, removed: 0 });

    const slo = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs/slo',
      headers: { cookie },
    });
    expect(slo.statusCode).toBe(200);
    expect(slo.json()).toMatchObject({ targetMs: expect.any(Number), jobs: expect.any(Array) });
  } finally {
    await server.close();
  }
});

test('Fastify previews bulk decrypts and serves durable notifications', async () => {
  const { server, cookie } = await signIn();
  const firstId = `bulk-first-${crypto.randomUUID()}`;
  const secondId = `bulk-second-${crypto.randomUUID()}`;
  recordJobHistory({
    id: firstId,
    bundleId: 'com.example.bulk-first',
    status: 'done',
    source: 'manual',
    createdAt: Date.now() - 10_000,
    finishedAt: Date.now() - 5_000,
    sizeBytes: 12 * 1024 * 1024,
  });
  recordJobHistory({
    id: secondId,
    bundleId: 'com.example.bulk-second',
    status: 'failed',
    source: 'manual',
    createdAt: Date.now() - 10_000,
    finishedAt: Date.now() - 4_000,
  });
  recordNotification({ userId: 'root', title: 'Test notification', message: 'Durable', severity: 'info' });

  try {
    const preview = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/jobs/bulk-preview',
      headers: { cookie },
      payload: { ids: [firstId, secondId] },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ requested: 2, eligible: 2, projectedQueueAdds: 2, previousSizeBytes: 12 * 1024 * 1024 });

    const notifications = await server.inject({ method: 'GET', url: '/v1/dashboard/notifications', headers: { cookie } });
    expect(notifications.statusCode).toBe(200);
    expect(notifications.json()).toMatchObject({ unread: expect.any(Number), notifications: expect.arrayContaining([expect.objectContaining({ message: 'Durable' })]) });

    const marked = await server.inject({ method: 'POST', url: '/v1/dashboard/notifications/read', headers: { cookie }, payload: {} });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({ ok: true, marked: expect.any(Number) });
  } finally {
    await server.close();
  }
});
