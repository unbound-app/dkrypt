import { expect, test } from 'bun:test';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { createTestFlightCatalogRoutes } from '#routes/decrypt.js';
import { createApiKey, revokeApiKey } from '#store/state.js';

test('typed TestFlight catalog routes enforce key scopes and normalize bridge failures', async () => {
  let trainLookupAppId = 0;
  let buildLookup: { appId: number; trainVersion: string } | undefined;
  let shouldFailTrainLookup = false;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  server.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    const status = typeof statusCode === 'number' ? statusCode : 500;
    const message = error instanceof Error ? error.message : String(error);
    reply.code(status).send({
      error: message,
      code: status === 400 ? 'validation_error' : 'internal_error',
      message,
      requestId: request.id,
      retryable: status >= 500,
    });
  });
  const deniedKey = createApiKey('TestFlight disabled route test', 'root', undefined, undefined, undefined, false);
  const allowedKey = createApiKey('TestFlight route test', 'root');

  try {
    await server.register(createTestFlightCatalogRoutes({
      listTrains: async (appId) => {
        trainLookupAppId = appId;
        if (shouldFailTrainLookup) throw new Error('device agent unavailable');
        return [{ trainVersion: '4.0', buildCount: 2 }];
      },
      listBuilds: async (appId, trainVersion) => {
        buildLookup = { appId, trainVersion };
        return [{ id: 12345, cfBundleShortVersion: '4.0', cfBundleVersion: '400', bundleId: 'com.example.app' }];
      },
    }));
    await server.ready();

    const unauthorized = await server.inject({ method: 'GET', url: '/v1/testflight/123/trains' });
    expect(unauthorized.statusCode).toBe(401);

    const denied = await server.inject({
      method: 'GET',
      url: '/v1/testflight/123/trains',
      headers: { authorization: `Bearer ${deniedKey.key}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'testflight_scope_denied', retryable: false });

    const malformed = await server.inject({
      method: 'GET',
      url: '/v1/testflight/not-an-app-id/trains',
      headers: { authorization: `Bearer ${allowedKey.key}` },
    });
    expect(malformed.statusCode).toBe(400);

    const trains = await server.inject({
      method: 'GET',
      url: '/v1/testflight/123/trains',
      headers: { authorization: `Bearer ${allowedKey.key}` },
    });
    expect(trains.statusCode).toBe(200);
    expect(trains.json() as unknown).toEqual({ trains: [{ trainVersion: '4.0', buildCount: 2 }] });
    expect(trainLookupAppId).toBe(123);

    const builds = await server.inject({
      method: 'GET',
      url: '/v1/testflight/123/builds?trainVersion=4.0',
      headers: { authorization: `Bearer ${allowedKey.key}` },
    });
    expect(builds.statusCode).toBe(200);
    expect(buildLookup).toEqual({ appId: 123, trainVersion: '4.0' });
    expect(builds.json() as unknown).toMatchObject({ builds: [{ id: 12345, bundleId: 'com.example.app' }] });

    shouldFailTrainLookup = true;
    const failure = await server.inject({
      method: 'GET',
      url: '/v1/testflight/123/trains',
      headers: { authorization: `Bearer ${allowedKey.key}` },
    });
    expect(failure.statusCode).toBe(502);
    expect(failure.json()).toMatchObject({ code: 'testflight_lookup_failed', requestId: expect.any(String), retryable: true });
  } finally {
    revokeApiKey(deniedKey.id, 'root', true);
    revokeApiKey(allowedKey.id, 'root', true);
    await server.close();
  }
});
