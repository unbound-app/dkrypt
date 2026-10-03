import { expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { authenticateGithubOidc, githubOidcPolicyMatches, verifyGithubOidcSignature, type GithubOidcClaims } from '#githubOidc.js';
import { createGithubOidcPolicy } from '#store/integrationRepository.js';
import type { GithubOidcPolicy } from '#store/integrationRepository.js';
import Fastify from 'fastify';
import { fastifyRequireApiKey, getFastifyApiKeyContext } from '#auth.js';

test('GitHub OIDC trust requires exact repository, workflow, ref, and audience', () => {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const policy: GithubOidcPolicy = { id: 'policy-1', kind: 'github_oidc', repositoryId: '123', workflowRef: 'owner/repo/.github/workflows/decrypt.yml@refs/heads/main', ref: 'refs/heads/main', audience: 'https://ipa.example.test', projectId: 'default', bundleIds: ['com.example.app'], allowTestFlight: false, enabled: true, createdBy: 'root', createdAt: now, updatedAt: now };
  const claims: GithubOidcClaims = { iss: 'https://token.actions.githubusercontent.com', sub: 'repo:owner/repo:ref:refs/heads/main', aud: policy.audience, exp: seconds + 300, iat: seconds, repository_id: policy.repositoryId, workflow_ref: policy.workflowRef, ref: policy.ref };
  expect(githubOidcPolicyMatches(policy, claims, now)).toBe(true);
  expect(githubOidcPolicyMatches(policy, { ...claims, aud: 'https://other.example.test' }, now)).toBe(false);
  expect(githubOidcPolicyMatches(policy, { ...claims, repository_id: '124' }, now)).toBe(false);
  expect(githubOidcPolicyMatches(policy, { ...claims, workflow_ref: 'owner/repo/.github/workflows/other.yml@refs/heads/main' }, now)).toBe(false);
  expect(githubOidcPolicyMatches(policy, { ...claims, ref: 'refs/heads/other' }, now)).toBe(false);
  expect(githubOidcPolicyMatches(policy, { ...claims, exp: seconds - 1 }, now)).toBe(false);
  expect(githubOidcPolicyMatches(policy, { ...claims, iat: seconds - 1000 }, now)).toBe(false);
  expect(githubOidcPolicyMatches({ ...policy, enabled: false }, claims, now)).toBe(false);
});

test('GitHub OIDC signature verification rejects modified tokens', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'https://token.actions.githubusercontent.com', repository_id: '123' })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  const token = `${header}.${payload}.${signature}`;
  expect(verifyGithubOidcSignature(token, publicKey.export({ format: 'jwk' }))).toMatchObject({ repository_id: '123' });
  const altered = Buffer.from(JSON.stringify({ iss: 'https://token.actions.githubusercontent.com', repository_id: '124' })).toString('base64url');
  expect(verifyGithubOidcSignature(`${header}.${altered}.${signature}`, publicKey.export({ format: 'jwk' }))).toBeUndefined();
});

test('GitHub OIDC authentication verifies the signed token and exact policy', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fixture-github-key';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' };
  const policy = createGithubOidcPolicy({ repositoryId: '987654321', workflowRef: 'owner/repo/.github/workflows/fixture.yml@refs/heads/main', ref: 'refs/heads/main', audience: 'https://ipa.example.test/fixture', projectId: 'default', bundleIds: ['com.example.fixture'], allowTestFlight: false, createdBy: 'root' });
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://token.actions.githubusercontent.com', sub: 'repo:owner/repo:ref:refs/heads/main', aud: policy.audience, exp: now + 300, iat: now, repository_id: policy.repositoryId, workflow_ref: policy.workflowRef, ref: policy.ref };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const tokenFor = (value: typeof claims) => {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    return `${header}.${payload}.${signature}`;
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ keys: [jwk] }), { preconnect: previousFetch.preconnect });
  try {
    expect((await authenticateGithubOidc(tokenFor(claims)))?.id).toBe(policy.id);
    expect(await authenticateGithubOidc(tokenFor({ ...claims, aud: 'https://wrong.example.test' }))).toBeUndefined();
    expect(await authenticateGithubOidc(tokenFor({ ...claims, repository_id: '42' }))).toBeUndefined();
    expect(await authenticateGithubOidc(tokenFor({ ...claims, exp: now - 1 }))).toBeUndefined();
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('GitHub OIDC authenticates only an existing public API operation with its configured scope', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'fixture-public-route-key';
  const policy = createGithubOidcPolicy({ repositoryId: '987654322', workflowRef: 'owner/repo/.github/workflows/public.yml@refs/heads/main', ref: 'refs/heads/main', audience: 'https://ipa.example.test/public', projectId: 'default', bundleIds: ['com.example.public'], allowTestFlight: false, createdBy: 'root' });
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'https://token.actions.githubusercontent.com', sub: 'repo:owner/repo:ref:refs/heads/main', aud: policy.audience, exp: now + 300, iat: now, repository_id: policy.repositoryId, workflow_ref: policy.workflowRef, ref: policy.ref })).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  const token = `${header}.${payload}.${signature}`;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' }] }), { preconnect: previousFetch.preconnect });
  const server = Fastify();
  server.get('/v1/jobs/:id', { preHandler: fastifyRequireApiKey }, (request) => ({ scope: getFastifyApiKeyContext(request) }));
  server.get('/v1/dashboard/private', { preHandler: fastifyRequireApiKey }, () => ({ ok: true }));
  try {
    const permitted = await server.inject({ method: 'GET', url: '/v1/jobs/job-1', headers: { authorization: `Bearer ${token}` } });
    expect(permitted.statusCode).toBe(200);
    expect(permitted.json().scope).toMatchObject({ projectId: 'default', allowedBundleIds: ['com.example.public'], allowTestFlight: false });
    const privateResponse = await server.inject({ method: 'GET', url: '/v1/dashboard/private', headers: { authorization: `Bearer ${token}` } });
    expect(privateResponse.statusCode).toBe(401);
  } finally {
    globalThis.fetch = previousFetch;
    await server.close();
  }
});
