import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { buildServer } from '#server.js';

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
