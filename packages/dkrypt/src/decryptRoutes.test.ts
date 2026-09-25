import { expect, test } from 'bun:test';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import type { ArtifactRecord } from '#artifacts.js';
import { createArtifactCatalogRoutes, createTestFlightCatalogRoutes } from '#routes/decrypt.js';
import { bulkSetApiKeyAllowedBundleIds, createApiKey, revokeApiKey } from '#store/state.js';

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

test('typed artifact metadata routes enforce API-key bundle scopes', async () => {
  const allowedArtifact: ArtifactRecord = {
    id: 'allowed-artifact',
    key: 'allowed-key',
    bundleId: 'com.example.allowed',
    channel: 'appstore',
    versionLabel: '1.0',
    filePath: '/unused/allowed.ipa',
    fileSizeBytes: 17,
    sha256: 'a'.repeat(64),
    createdAt: 1_700_000_000_000,
    lastAccessedAt: 1_700_000_000_000,
    accessCount: 1,
  };
  const deniedArtifact: ArtifactRecord = {
    ...allowedArtifact,
    id: 'denied-artifact',
    key: 'denied-key',
    bundleId: 'com.example.denied',
    filePath: '/unused/denied.ipa',
  };
  let listedBundleIds: string[] | undefined;
  const apiKey = createApiKey('Scoped artifact metadata route test', 'root', undefined, ['com.example.allowed']);
  const emptyScopeApiKey = createApiKey('Empty-scope artifact metadata route test', 'root');
  bulkSetApiKeyAllowedBundleIds([emptyScopeApiKey.id], []);
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();

  try {
    await server.register(createArtifactCatalogRoutes({
      listArtifacts: (options) => {
        listedBundleIds = options?.bundleIds;
        return { artifacts: [allowedArtifact], total: 1, totalBytes: allowedArtifact.fileSizeBytes, maxBytes: 100 };
      },
      getArtifactById: (id) => id === allowedArtifact.id ? allowedArtifact : id === deniedArtifact.id ? deniedArtifact : undefined,
      artifactFileAvailable: (artifact) => Boolean(artifact),
    }));
    await server.ready();

    const headers = { authorization: `Bearer ${apiKey.key}` };
    const listing = await server.inject({ method: 'GET', url: '/v1/artifacts', headers });
    expect(listing.statusCode).toBe(200);
    expect(listedBundleIds).toEqual(['com.example.allowed']);
    expect(listing.json() as unknown).toMatchObject({
      artifacts: [{ bundleId: 'com.example.allowed' }],
      total: 1,
      totalBytes: 17,
    });

    const allowed = await server.inject({ method: 'GET', url: `/v1/artifacts/${allowedArtifact.id}`, headers });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json() as unknown).toMatchObject({ id: allowedArtifact.id, bundleId: 'com.example.allowed' });

    const denied = await server.inject({ method: 'GET', url: `/v1/artifacts/${deniedArtifact.id}`, headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'bundle_scope_denied', retryable: false });

    const missing = await server.inject({ method: 'GET', url: '/v1/artifacts/missing-artifact', headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'request_error', error: 'artifact not found' });

    const emptyScopeHeaders = { authorization: `Bearer ${emptyScopeApiKey.key}` };
    const emptyScopeListing = await server.inject({ method: 'GET', url: '/v1/artifacts', headers: emptyScopeHeaders });
    expect(emptyScopeListing.statusCode).toBe(200);
    expect(listedBundleIds).toBeUndefined();

    const emptyScopeDetail = await server.inject({ method: 'GET', url: `/v1/artifacts/${deniedArtifact.id}`, headers: emptyScopeHeaders });
    expect(emptyScopeDetail.statusCode).toBe(200);
  } finally {
    revokeApiKey(apiKey.id, 'root', true);
    revokeApiKey(emptyScopeApiKey.id, 'root', true);
    await server.close();
  }
});
