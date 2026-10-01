import { expect, test } from 'bun:test';
import { assertDatabaseHealth } from '#deploymentHealthProbe.js';

test('deployment health probe sends the internal API key and accepts a healthy database', async () => {
  let request: { input?: string | URL | Request; init?: RequestInit } = {};
  await assertDatabaseHealth({
    baseUrl: 'http://127.0.0.1:8080',
    apiKey: 'deployment-probe-key',
    fetcher: async (input, init) => {
      request = { input, init };
      return new Response(JSON.stringify({ database: { integrity: 'ok' } }), { status: 200 });
    },
  });
  expect(request.input).toBe('http://127.0.0.1:8080/v1/health');
  expect(request.init?.headers).toEqual({ authorization: 'Bearer deployment-probe-key' });
});

test('deployment health probe rejects unhealthy or malformed responses', async () => {
  await expect(assertDatabaseHealth({
    fetcher: async () => new Response(JSON.stringify({ database: { integrity: 'failed' } }), { status: 503 }),
  })).rejects.toThrow('health probe failed: HTTP 503, database integrity is failed');

  await expect(assertDatabaseHealth({
    fetcher: async () => new Response('unavailable', { status: 200 }),
  })).rejects.toThrow('health probe failed: HTTP 200, database integrity is unknown');
});
