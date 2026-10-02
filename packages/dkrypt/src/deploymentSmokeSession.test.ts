import { expect, test } from 'bun:test';
import { createDeploymentSmokeSession } from '#deploymentSmokeSession.js';

test('deployment smoke session creates a same-origin cookie and logs out through the matching session', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith('/v1/auth/login')) return new Response('{}', { status: 200, headers: { 'set-cookie': 'session=login-token; Path=/; HttpOnly' } });
    return new Response(null, { status: 204 });
  });

  const session = await createDeploymentSmokeSession('http://127.0.0.1:8080', fetcher);

  expect(session.cookie).toBe('session=login-token');
  expect(session.headers).toMatchObject({
    cookie: session.cookie,
    origin: expect.any(String),
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  });
  await session.logout();
  expect(calls.map(({ url }) => url)).toEqual([
    'http://127.0.0.1:8080/v1/auth/login',
    'http://127.0.0.1:8080/v1/auth/logout',
  ]);
  expect(calls[1]?.init).toMatchObject({ method: 'POST', headers: session.headers });
});

test('deployment smoke session mints an administrator cookie after the root MFA challenge', async () => {
  const fetcher = async () => new Response(JSON.stringify({ code: 'mfa_required' }), { status: 401 });

  const session = await createDeploymentSmokeSession('http://127.0.0.1:8080', fetcher);

  expect(session.cookie).toMatch(/^session=/);
  expect(session.cookie).not.toContain('mfa_required');
});

test('deployment smoke session rejects failed login responses', async () => {
  const fetcher = async () => new Response(JSON.stringify({ code: 'invalid_credentials' }), { status: 401 });

  await expect(createDeploymentSmokeSession('http://127.0.0.1:8080', fetcher)).rejects.toThrow('smoke login failed: HTTP 401, code=invalid_credentials');
});
