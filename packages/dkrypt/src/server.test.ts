import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { enqueueDecryptJob, reclaimJobFile } from '#jobs/store.js';
import { buildServer } from '#server.js';
import { recordJobHistory, recordNotification, recordShareLink, revokeShareLink } from '#store/state.js';
import { buildSignedFileUrlWithToken } from '#util/signedUrl.js';

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

test('Fastify includes live download metadata in history events', async () => {
  const { server, cookie } = await signIn();
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const id = `live-history-${crypto.randomUUID()}`;
  const token = `token-${crypto.randomUUID()}`;
  const link = recordShareLink(id, 'com.example.live-history', token, 'system', Date.now() + 60_000);

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
      createdAt: Date.now() - 1_000,
      finishedAt: Date.now(),
    });

    const next = await reader.read();
    const text = new TextDecoder().decode(next.value);
    const match = text.match(/event: history\ndata: (.+)\n\n/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? '')).toMatchObject({
      id,
      activeShareUrl: expect.stringContaining(`/v1/jobs/${id}/file?token=${token}`),
      fileAvailable: false,
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    revokeShareLink(link.id);
    await server.close();
  }
});

test('Fastify explains when a history job no longer has an IPA to share', async () => {
  const { server, cookie } = await signIn();
  const id = `cleaned-job-${crypto.randomUUID()}`;
  recordJobHistory({
    id,
    bundleId: 'com.example.cleaned',
    status: 'done',
    source: 'manual',
    createdAt: Date.now() - 1_000,
    finishedAt: Date.now(),
  });

  try {
    const response = await server.inject({
      method: 'POST',
      url: `/v1/dashboard/jobs/${id}/share`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json() as { error?: string }).toEqual({
      error: 'the decrypted IPA has been cleaned up and can no longer be shared',
    });
  } finally {
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

test('Fastify exposes system-issued scheduler share links in recent jobs', async () => {
  const { server, cookie } = await signIn();
  const id = `scheduler-share-${crypto.randomUUID()}`;
  const token = `token-${crypto.randomUUID()}`;
  recordJobHistory({
    id,
    bundleId: 'com.example.scheduler-share',
    status: 'done',
    source: 'scheduler',
    createdAt: Date.now() - 1_000,
    finishedAt: Date.now(),
  });
  const link = recordShareLink(id, 'com.example.scheduler-share', token, 'system', Date.now() + 60_000);

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/jobs?q=com.example.scheduler-share',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { history: Array<{ id: string; activeShareUrl?: string }> };
    expect(body.history.find((entry) => entry.id === id)?.activeShareUrl).toContain(`/v1/jobs/${id}/file?token=${token}`);
  } finally {
    revokeShareLink(link.id);
    await server.close();
  }
});

test('Fastify serves a signed scheduler share link while the job is retained', async () => {
  const server = await buildServer({ includePublicRoutes: false });
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-scheduler-download-'));
  const outputPath = path.join(outputDir, 'app.ipa');
  await writeFile(outputPath, 'ipa');
  const job = enqueueDecryptJob(
    'com.example.scheduler-download',
    'scheduler',
    undefined,
    undefined,
    undefined,
    undefined,
    0,
    `unavailable-device-${crypto.randomUUID()}`,
  );
  job.status = 'done';
  job.filePath = outputPath;
  job.fileSizeBytes = 3;
  job.finishedAt = Date.now();
  const share = buildSignedFileUrlWithToken(job.id, 60);
  const link = recordShareLink(job.id, job.bundleId, share.token, 'system', share.expiresAtMs);

  try {
    const response = await server.inject({
      method: 'GET',
      url: `/v1/jobs/${job.id}/file?token=${encodeURIComponent(share.token)}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('ipa');
  } finally {
    revokeShareLink(link.id);
    await reclaimJobFile(job);
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
