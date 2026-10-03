import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import type { Response } from '#http.js';
import { dashboardApiKeyRoutes } from '#routes/dashboardApiKeyRoutes.js';
import { createApiKey, verifyApiKey } from '#store/state.js';

function sessionCookie(): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions: PermissionFlag.administrator });
  return value.split(';', 1)[0]!;
}

test('scope simulation shows only routes allowed for the selected project, bundle, and source', async () => {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(dashboardApiKeyRoutes);
  try {
    const request = (body: Record<string, unknown>) => server.inject({ method: 'POST', url: '/v1/dashboard/keys/simulate', headers: { cookie: sessionCookie() }, payload: { projectId: 'default', bundleId: 'com.example.allowed', source: 'appstore', ...body } });
    const outsideScope = await request({ allowedBundleIds: ['com.example.other'] });
    expect(outsideScope.statusCode).toBe(200);
    expect(outsideScope.json().allowed).toBe(false);
    expect(outsideScope.json().routes).toEqual([]);
    const malformedScope = await request({ allowedBundleIds: ['not a bundle'] });
    expect(malformedScope.json().allowed).toBe(true);
    expect(malformedScope.json().warnings).toHaveLength(1);
    const testFlight = await request({ source: 'testflight', allowTestFlight: false });
    expect(testFlight.json().allowed).toBe(false);
    expect(testFlight.json().operations.find((operation: { route: string }) => operation.route === 'POST /v1/testflight/decrypt').allowed).toBe(false);
    expect(testFlight.json().operations.find((operation: { route: string }) => operation.route === 'GET /v1/artifacts').allowed).toBe(true);
  } finally {
    await server.close();
  }
});

test('scope simulation reflects an existing key daily limit without consuming a request', async () => {
  const key = createApiKey('simulation-test', 'root', undefined, ['com.example.allowed'], 1);
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(dashboardApiKeyRoutes);
  try {
    const before = await server.inject({ method: 'POST', url: '/v1/dashboard/keys/simulate', headers: { cookie: sessionCookie() }, payload: { keyId: key.id, projectId: 'default', bundleId: 'com.example.allowed', source: 'appstore' } });
    expect(before.json().allowed).toBe(true);
    expect(before.json().limits).toMatchObject({ daily: 1, dailyUsed: 0, dailyRemaining: 1 });
    expect(verifyApiKey(key.key)).toBeDefined();
    const after = await server.inject({ method: 'POST', url: '/v1/dashboard/keys/simulate', headers: { cookie: sessionCookie() }, payload: { keyId: key.id, projectId: 'default', bundleId: 'com.example.allowed', source: 'appstore' } });
    expect(after.json().allowed).toBe(false);
    expect(after.json().limits).toMatchObject({ daily: 1, dailyUsed: 1, dailyRemaining: 0 });
    expect(after.json().routes).toEqual([]);
    expect(verifyApiKey(key.key)).toBe('rate-limited');
  } finally {
    await server.close();
  }
});
