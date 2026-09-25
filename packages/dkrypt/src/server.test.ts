import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { buildArtifactFileUrl, promoteArtifact, touchArtifact } from '#artifacts.js';
import { exportBillingSnapshot, replaceBillingSnapshot, upsertBillingSubscription } from '#billing.js';
import { upsertAuthProfile } from '#identity.js';
import { scopedLogger } from '#logger.js';
import { emitJobsChanged } from '#events.js';
import { PermissionFlag, serializeBits } from '#permissions.js';
import { buildServer } from '#server.js';
import type { Response } from '#http.js';
import { addAllowedUser, createApiKey, createProject, createRole, createTestFlightSubscription, createWatch, deleteWatch, recordAudit, recordDeviceActivity, recordGitHubBudgetTelemetry, recordJobHistory, recordNotification, revokeApiKey, updateRole, withdrawTestFlightSubscription } from '#store/state.js';
import { setSessionCookie } from '#session.js';

function createSessionCookie(userId: string, permissions: bigint): string {
  let cookieHeader = '';
  const response = { setHeader: (_name: string, value: string) => { cookieHeader = value; } } as unknown as Response;
  setSessionCookie(response, { sub: userId, permissions });
  return cookieHeader.split(';', 1)[0];
}

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

  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices',
      headers: { cookie },
      payload: { name: 'test device', transport: 'wifi', host: '192.168.1.10', port: 22, user: 'mobile' },
    });
    expect(created.statusCode).toBe(201);
    const device = created.json() as { id: string; name: string; host?: string; rootDir?: string };
    expect(device.name).toBe('test device');
    expect(device.host).toBe('192.168.1.10');
    expect(device.rootDir).toBeUndefined();

    const overview = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers: { cookie } });
    expect(overview.statusCode).toBe(200);
    expect((overview.json() as { devices: { id: string }[] }).devices.some((candidate) => candidate.id === device.id)).toBe(true);

    const deleted = await server.inject({ method: 'DELETE', url: `/v1/dashboard/devices/${device.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(200);
  } finally {
    await server.close();
  }
});

test('project administration is permission-gated and project membership controls visibility', async () => {
  const root = await signIn();
  const managerId = `github:project-manager-${crypto.randomUUID()}`;
  const firstMemberId = `github:project-member-a-${crypto.randomUUID()}`;
  const secondMemberId = `github:project-member-b-${crypto.randomUUID()}`;
  const managerPermissions = PermissionFlag.viewProjects | PermissionFlag.manageProjects | PermissionFlag.requestDecrypt;
  const managerRole = createRole({ name: `Project manager ${crypto.randomUUID()}`, color: '#5865f2', permissions: serializeBits(managerPermissions) }, 'test');
  const memberPermissions = PermissionFlag.requestDecrypt | PermissionFlag.viewLogs;
  const memberRole = createRole({ name: `Project member ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(memberPermissions) }, 'test');
  addAllowedUser(managerId, [managerRole.id], 'test');
  addAllowedUser(firstMemberId, [memberRole.id], 'test');
  addAllowedUser(secondMemberId, [memberRole.id], 'test');
  const managerCookie = createSessionCookie(managerId, managerPermissions);
  const memberCookie = createSessionCookie(firstMemberId, memberPermissions);
  const secondMemberCookie = createSessionCookie(secondMemberId, memberPermissions);
  let projectArtifactPath = '';

  try {
    const server = root.server;
    const deniedCreate = await server.inject({ method: 'POST', url: '/v1/dashboard/projects', headers: { cookie: memberCookie }, payload: { name: `Denied ${crypto.randomUUID()}` } });
    expect(deniedCreate.statusCode).toBe(403);

    const created = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/projects',
      headers: { cookie: managerCookie },
      payload: { name: `Team ${crypto.randomUUID()}`, memberIds: [firstMemberId], dailyJobQuota: 40 },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json() as { id: string; memberIds: string[]; dailyJobQuota: number };
    expect(project.memberIds).toContain(managerId);
    expect(project.memberIds).toContain(firstMemberId);
    expect(project.dailyJobQuota).toBe(40);

    const firstMemberProjects = await server.inject({ method: 'GET', url: '/v1/dashboard/projects', headers: { cookie: memberCookie } });
    const firstProjectIds = (firstMemberProjects.json() as { projects: { id: string }[] }).projects.map((entry) => entry.id);
    expect(firstProjectIds).toContain('default');
    expect(firstProjectIds).toContain(project.id);

    const secondMemberProjects = await server.inject({ method: 'GET', url: '/v1/dashboard/projects', headers: { cookie: secondMemberCookie } });
    const secondProjectIds = (secondMemberProjects.json() as { projects: { id: string }[] }).projects.map((entry) => entry.id);
    expect(secondProjectIds).not.toContain(project.id);

    const bundleId = `com.example.project-scope.${crypto.randomUUID()}`;
    const historyId = `project-history-${crypto.randomUUID()}`;
    const defaultHistoryId = `default-history-${crypto.randomUUID()}`;
    const createdAt = Date.now();
    recordJobHistory({ id: historyId, correlationId: `project-correlation-${historyId}`, projectId: project.id, bundleId, status: 'done', source: 'manual', createdAt, finishedAt: createdAt, sizeBytes: 5, ipaInfoPlist: { CFBundleVersion: 'project' } });
    recordJobHistory({ id: defaultHistoryId, correlationId: `default-correlation-${defaultHistoryId}`, projectId: 'default', bundleId, status: 'done', source: 'manual', createdAt, finishedAt: createdAt, sizeBytes: 13, ipaInfoPlist: { CFBundleVersion: 'default' } });
    scopedLogger('project-scope-test').info('project scope marker', { jobId: historyId });
    scopedLogger('project-scope-test').info('project scope marker', { jobId: defaultHistoryId });
    const memberHistory = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs?projectId=${project.id}&q=${bundleId}`, headers: { cookie: memberCookie } });
    const otherMemberHistory = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs?projectId=${project.id}&q=${bundleId}`, headers: { cookie: secondMemberCookie } });
    const crossProjectDiff = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/diff?projectId=${project.id}&bundleId=${bundleId}&a=${historyId}&b=${defaultHistoryId}`, headers: { cookie: memberCookie } });
    const scopedBulkPreview = await server.inject({ method: 'POST', url: '/v1/dashboard/jobs/bulk-preview', headers: { cookie: memberCookie }, payload: { projectId: project.id, ids: [historyId, defaultHistoryId] } });
    const scopedStats = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/stats/${bundleId}?projectId=${project.id}`, headers: { cookie: memberCookie } });
    const scopedInsights = await server.inject({ method: 'GET', url: `/v1/dashboard/insights?projectId=${project.id}`, headers: { cookie: memberCookie } });
    const scopedLogs = await server.inject({ method: 'GET', url: `/v1/dashboard/logs?projectId=${project.id}&scope=project-scope-test&q=marker`, headers: { cookie: memberCookie } });
    expect(memberHistory.statusCode).toBe(200);
    expect((memberHistory.json() as { history: { id: string }[] }).history.map((entry) => entry.id)).toContain(historyId);
    expect(otherMemberHistory.statusCode).toBe(404);
    expect(crossProjectDiff.statusCode).toBe(404);
    expect(scopedBulkPreview.statusCode).toBe(200);
    expect(scopedBulkPreview.json()).toMatchObject({ requested: 2, eligible: 1, previousSizeBytes: 5, items: [{ id: historyId }] });
    expect(scopedStats.json()).toMatchObject({ totalRuns: 1, doneCount: 1, failedCount: 0 });
    expect((scopedInsights.json() as { totalRuns: number }).totalRuns).toBe(1);
    expect((scopedLogs.json() as { logs: { meta?: { jobId?: string } }[] }).logs.map((entry) => entry.meta?.jobId)).toEqual([historyId]);

    const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'dkrypt-project-artifact-'));
    projectArtifactPath = path.join(artifactDirectory, 'project.ipa');
    await writeFile(projectArtifactPath, 'project ipa');
    const projectArtifact = await promoteArtifact({
      key: `${bundleId}|appstore|project-build`,
      bundleId,
      channel: 'appstore',
      projectId: project.id,
      stagingPath: projectArtifactPath,
    });
    projectArtifactPath = projectArtifact.filePath;
    const memberArtifacts = await server.inject({ method: 'GET', url: `/v1/dashboard/artifacts?projectId=${project.id}&q=${bundleId}`, headers: { cookie: memberCookie } });
    const otherMemberArtifact = await server.inject({ method: 'GET', url: `/v1/dashboard/artifacts/${projectArtifact.id}/file`, headers: { cookie: secondMemberCookie } });
    expect(memberArtifacts.statusCode).toBe(200);
    expect((memberArtifacts.json() as { artifacts: { id: string }[] }).artifacts.map((entry) => entry.id)).toContain(projectArtifact.id);
    expect(otherMemberArtifact.statusCode).toBe(404);

    const members = await server.inject({ method: 'GET', url: '/v1/dashboard/projects/members', headers: { cookie: managerCookie } });
    expect((members.json() as { members: { id: string }[] }).members.map((member) => member.id)).toContain(firstMemberId);

    const archived = await server.inject({ method: 'PATCH', url: `/v1/dashboard/projects/${project.id}`, headers: { cookie: managerCookie }, payload: { archived: true } });
    expect(archived.statusCode).toBe(200);
    const archivedDecrypt = await server.inject({ method: 'POST', url: '/v1/dashboard/decrypt', headers: { cookie: managerCookie }, payload: { projectId: project.id, bundleId: 'com.example.archived' } });
    const archivedPreflight = await server.inject({ method: 'POST', url: '/v1/dashboard/decrypt/preflight', headers: { cookie: managerCookie }, payload: { projectId: project.id, bundleId: 'com.example.archived' } });
    const archivedRetry = await server.inject({ method: 'POST', url: `/v1/dashboard/jobs/${historyId}/retry`, headers: { cookie: managerCookie } });
    expect(archivedDecrypt.statusCode).toBe(409);
    expect(archivedPreflight.statusCode).toBe(409);
    expect(archivedRetry.statusCode).toBe(409);
  } finally {
    if (projectArtifactPath) await rm(projectArtifactPath, { force: true });
    await root.server.close();
  }
});

test('project event streams close immediately after membership is revoked', async () => {
  const { server, cookie } = await signIn();
  const memberId = `github:project-stream-${crypto.randomUUID()}`;
  const memberPermissions = PermissionFlag.requestDecrypt | PermissionFlag.viewDevices;
  const role = createRole({ name: `Stream ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(memberPermissions) }, 'test');
  addAllowedUser(memberId, [role.id], 'test');
  const memberCookie = createSessionCookie(memberId, memberPermissions);
  const projectResponse = await server.inject({
    method: 'POST',
    url: '/v1/dashboard/projects',
    headers: { cookie },
    payload: { name: `Stream ${crypto.randomUUID()}`, memberIds: [memberId] },
  });
  const project = projectResponse.json() as { id: string };
  const baseUrl = await server.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();

  try {
    const response = await fetch(`${baseUrl}/v1/dashboard/events?projectId=${project.id}`, { headers: { cookie: memberCookie }, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('dashboard event stream has no reader');
    const initial = await reader.read();
    expect(new TextDecoder().decode(initial.value)).toContain('event: overview');

    expect(updateRole(role.id, { permissions: serializeBits(PermissionFlag.requestDecrypt) }, 'test').ok).toBe(true);
    emitJobsChanged();
    const permissionRevokedEvent = await reader.read();
    expect(new TextDecoder().decode(permissionRevokedEvent.value)).toContain('event: project-access-revoked');
    expect((await reader.read()).done).toBe(true);

    const refreshedResponse = await fetch(`${baseUrl}/v1/dashboard/events?projectId=${project.id}`, { headers: { cookie: memberCookie } });
    expect(refreshedResponse.status).toBe(200);
    const refreshedReader = refreshedResponse.body?.getReader();
    if (!refreshedReader) throw new Error('refreshed dashboard event stream has no reader');
    expect(new TextDecoder().decode((await refreshedReader.read()).value)).toContain('event: overview');

    const revoked = await server.inject({ method: 'PATCH', url: `/v1/dashboard/projects/${project.id}`, headers: { cookie }, payload: { memberIds: [] } });
    expect(revoked.statusCode).toBe(200);
    const event = await refreshedReader.read();
    expect(new TextDecoder().decode(event.value)).toContain('event: project-access-revoked');
    expect((await refreshedReader.read()).done).toBe(true);

    const deniedReconnect = await fetch(`${baseUrl}/v1/dashboard/events?projectId=${project.id}`, { headers: { cookie: memberCookie } });
    expect(deniedReconnect.status).toBe(404);
  } finally {
    controller.abort();
    await server.close();
  }
});

test('scheduler watch lists and budget history stay within the selected project', async () => {
  const { server } = await signIn();
  const memberId = `github:project-watch-${crypto.randomUUID()}`;
  const permissions = PermissionFlag.viewAutomation | PermissionFlag.manageAutomation;
  const role = createRole({ name: `Watch manager ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(permissions) }, 'test');
  addAllowedUser(memberId, [role.id], 'test');
  const memberCookie = createSessionCookie(memberId, permissions);
  const accessibleProject = createProject({ name: `Accessible ${crypto.randomUUID()}`, memberIds: [memberId] }, 'root').project!;
  const hiddenProject = createProject({ name: `Hidden ${crypto.randomUUID()}` }, 'root').project!;
  const accessibleWatch = createWatch({
    projectId: accessibleProject.id,
    bundleId: `com.example.watch.${crypto.randomUUID()}`,
    repo: 'owner/repo',
    ghWorkflowFile: 'release.yml',
    pollCron: '0 * * * *',
    enabled: false,
  }, 'test').watch!;
  const hiddenWatch = createWatch({
    projectId: hiddenProject.id,
    bundleId: `com.example.watch.${crypto.randomUUID()}`,
    repo: 'owner/repo',
    ghWorkflowFile: 'release.yml',
    pollCron: '0 * * * *',
    enabled: false,
  }, 'test').watch!;
  const telemetry = (watchId: string, bundleId: string) => recordGitHubBudgetTelemetry({
    watchId,
    bundleId,
    estimatedRequests: 5,
    limit: 5000,
    remainingBefore: 4995,
    resetAt: Date.now() + 60_000,
  });
  telemetry(accessibleWatch.id, accessibleWatch.bundleId);
  telemetry(hiddenWatch.id, hiddenWatch.bundleId);

  try {
    const watchesResponse = await server.inject({ method: 'GET', url: '/v1/dashboard/watches', headers: { cookie: memberCookie } });
    const watches = (watchesResponse.json() as { watches: { id: string }[] }).watches;
    const budgetResponse = await server.inject({ method: 'GET', url: `/v1/dashboard/github/budget-history?projectId=${accessibleProject.id}`, headers: { cookie: memberCookie } });
    const entries = (budgetResponse.json() as { entries: { watchId: string }[] }).entries;

    expect(watchesResponse.statusCode).toBe(200);
    expect(watches.map((watch) => watch.id)).toContain(accessibleWatch.id);
    expect(watches.map((watch) => watch.id)).not.toContain(hiddenWatch.id);
    expect(budgetResponse.statusCode).toBe(200);
    expect(entries.map((entry) => entry.watchId)).toEqual([accessibleWatch.id]);
  } finally {
    deleteWatch(accessibleWatch.id, 'test');
    deleteWatch(hiddenWatch.id, 'test');
    await server.close();
  }
});

test('Fastify rejects obsolete device root submissions', async () => {
  const { server, cookie } = await signIn();

  try {
    const created = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices',
      headers: { cookie },
      payload: { name: 'legacy device', rootDir: '/root/.ipadecrypt' },
    });
    expect(created.statusCode).toBe(400);
    expect((created.json() as { error: string }).error).toBe('device setup requires a discovered USB or Wi-Fi connection');

    const normal = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/devices',
      headers: { cookie },
      payload: { name: 'normal device', transport: 'wifi', host: '192.168.1.10', port: 22, user: 'mobile' },
    });
    const device = normal.json() as { id: string };
    const patched = await server.inject({
      method: 'PATCH',
      url: `/v1/dashboard/devices/${device.id}`,
      headers: { cookie },
      payload: { rootDir: '/root/.ipadecrypt' },
    });
    expect(patched.statusCode).toBe(400);
    expect((patched.json() as { error: string }).error).toBe('device setup requires a discovered USB or Wi-Fi connection');
    await server.inject({ method: 'DELETE', url: `/v1/dashboard/devices/${device.id}`, headers: { cookie } });
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

test('Fastify emits a narrow content security policy', async () => {
  const server = await buildServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({ method: 'GET', url: '/v1/status' });
    const policy = response.headers['content-security-policy'];
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("style-src-elem 'self'");
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    expect(policy).not.toContain("style-src 'self' 'unsafe-inline'");
  } finally {
    await server.close();
  }
});

test('Fastify normalizes API errors into the shared error envelope', async () => {
  const server = await buildServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({ method: 'GET', url: '/v1/dashboard/overview' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: expect.any(String),
      code: expect.any(String),
      message: expect.any(String),
      requestId: expect.any(String),
      retryable: false,
    });
  } finally {
    await server.close();
  }
});

test('health responses expose transport and subsystem recovery states', async () => {
  const server = await buildServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { authorization: `Bearer ${process.env.API_KEY}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      device: {
        transportState: expect.stringMatching(/^(discovered|pairing|connecting|ready|degraded|recovering|offline|unsupported)$/),
        capabilities: expect.any(Array),
        recoveryState: expect.stringMatching(/^(stable|recovering|degraded|offline)$/),
      },
    });
  } finally {
    await server.close();
  }
});

test('Fastify exposes coarse public service status without device details', async () => {
  const server = await buildServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({ method: 'GET', url: '/v1/status' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: expect.stringMatching(/^(operational|degraded|maintenance)$/),
      checkedAt: expect.any(String),
      components: {
        service: { state: expect.any(String) },
        automation: { state: expect.any(String) },
        scheduler: { state: expect.any(String) },
      },
    });
    expect(response.body).not.toContain('deviceId');
    expect(response.body).not.toContain('capabilities');
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
    expect(retention.json()).toMatchObject({
      retentionDays: 0,
      removed: 0,
      agePruned: 0,
      afterNextWrite: expect.any(Number),
      maxEntries: 100,
    });

    const artifactRetention = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/artifacts/retention-preview?maxBytes=1',
      headers: { cookie },
    });
    expect(artifactRetention.statusCode).toBe(200);
    expect(artifactRetention.json()).toMatchObject({
      targetMaxBytes: 1,
      currentCount: expect.any(Number),
      currentBytes: expect.any(Number),
      evictedCount: expect.any(Number),
      evictionExamples: expect.any(Array),
    });

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

test('job history cursors do not repeat rows when a newer job is added between pages', async () => {
  const { server, cookie } = await signIn();
  const bundlePrefix = `com.example.cursor-${crypto.randomUUID()}`;
  const historyEntry = (suffix: string, finishedAt: number) => ({
    id: `${bundlePrefix}-${suffix}`,
    bundleId: `${bundlePrefix}.${suffix}`,
    status: 'done' as const,
    source: 'manual' as const,
    createdAt: finishedAt - 1_000,
    finishedAt,
  });
  const existing = [
    historyEntry('a', 1_000),
    historyEntry('b', 2_000),
    historyEntry('c', 3_000),
    historyEntry('d', 4_000),
  ];
  for (const entry of existing) recordJobHistory(entry);

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/jobs?limit=2&q=${encodeURIComponent(bundlePrefix)}`,
      headers: { cookie },
    });
    const first = firstResponse.json() as { history: { id: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.history.map((entry) => entry.id)).toEqual([existing[3].id, existing[2].id]);
    expect(first.nextCursor).toEqual(expect.any(String));

    recordJobHistory(historyEntry('new', 5_000));
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/jobs?limit=2&q=${encodeURIComponent(bundlePrefix)}&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { history: { id: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.history.map((entry) => entry.id)).toEqual([existing[1].id, existing[0].id]);
  } finally {
    await server.close();
  }
});

test('notification cursors keep their boundary when a newer notification arrives', async () => {
  const { server, cookie } = await signIn();
  recordNotification({ userId: 'root', title: `Cursor seed ${crypto.randomUUID()}`, message: 'Older entry', severity: 'info' });
  recordNotification({ userId: 'root', title: `Cursor seed ${crypto.randomUUID()}`, message: 'Oldest entry', severity: 'info' });

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/notifications?limit=1',
      headers: { cookie },
    });
    const first = firstResponse.json() as { notifications: { id: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.notifications).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));

    const expectedNextResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/notifications?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const expectedNext = expectedNextResponse.json() as { notifications: { id: string }[] };

    await Bun.sleep(2);
    recordNotification({ userId: 'root', title: `Cursor arrival ${crypto.randomUUID()}`, message: 'Newer entry', severity: 'info' });
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/notifications?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { notifications: { id: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.notifications.map((entry) => entry.id)).toEqual(expectedNext.notifications.map((entry) => entry.id));
  } finally {
    await server.close();
  }
});

test('artifact cursors keep their boundary when a newer artifact is promoted', async () => {
  const { server, cookie } = await signIn();
  const bundleId = `com.example.cursor-${crypto.randomUUID()}`;
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-cursor-'));
  const artifacts = [];
  for (const [index, suffix] of ['a', 'b', 'c', 'd'].entries()) {
    const stagingPath = path.join(outputDir, `${suffix}.ipa`);
    await writeFile(stagingPath, `cursor artifact ${suffix}`);
    artifacts.push(await promoteArtifact({
      key: `${bundleId}|appstore|${suffix}`,
      bundleId,
      channel: 'appstore',
      externalVersionId: suffix,
      stagingPath,
    }));
    if (index < 3) await Bun.sleep(2);
  }

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/artifacts?limit=2&q=${encodeURIComponent(bundleId)}`,
      headers: { cookie },
    });
    const first = firstResponse.json() as { artifacts: { id: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.artifacts.map((artifact) => artifact.id)).toEqual([artifacts[3].id, artifacts[2].id]);
    expect(first.nextCursor).toEqual(expect.any(String));

    await Bun.sleep(2);
    const stagingPath = path.join(outputDir, 'new.ipa');
    await writeFile(stagingPath, 'cursor artifact newer');
    artifacts.push(await promoteArtifact({
      key: `${bundleId}|appstore|new`,
      bundleId,
      channel: 'appstore',
      externalVersionId: 'new',
      stagingPath,
    }));
    await touchArtifact(artifacts[1]);
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/artifacts?limit=2&q=${encodeURIComponent(bundleId)}&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { artifacts: { id: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.artifacts.map((artifact) => artifact.id)).toEqual([artifacts[1].id, artifacts[0].id]);
  } finally {
    await Promise.all(artifacts.map((artifact) => rm(artifact.filePath, { force: true })));
    await rm(outputDir, { recursive: true, force: true });
    await server.close();
  }
});

test('artifact pinning is scoped, persistent, audited, and available in the library response', async () => {
  const { server, cookie } = await signIn();
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-pin-route-'));
  const stagingPath = path.join(outputDir, 'pinned.ipa');
  await writeFile(stagingPath, 'pinned ipa');
  const artifact = await promoteArtifact({
    key: `test-pin-route-${crypto.randomUUID()}`,
    bundleId: 'com.example.pin-route',
    channel: 'appstore',
    externalVersionId: `pin-${crypto.randomUUID()}`,
    stagingPath,
  });

  try {
    const pinned = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/artifacts/${artifact.id}/pin`,
      headers: { cookie },
      payload: { pinned: true },
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toMatchObject({ ok: true, artifactId: artifact.id, pinned: true, pinnedAt: expect.any(String) });

    const library = await server.inject({ method: 'GET', url: '/v1/dashboard/artifacts?q=com.example.pin-route', headers: { cookie } });
    expect(library.statusCode).toBe(200);
    expect(library.json().artifacts[0]).toMatchObject({ id: artifact.id, pinnedAt: expect.any(String) });

    const audit = await server.inject({ method: 'GET', url: '/v1/dashboard/audit-log?limit=10', headers: { cookie } });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().entries).toContainEqual(expect.objectContaining({ action: 'artifact.pin', target: artifact.id }));

    const unpinned = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/artifacts/${artifact.id}/pin`,
      headers: { cookie },
      payload: { pinned: false },
    });
    expect(unpinned.statusCode).toBe(200);
    expect(unpinned.json()).toMatchObject({ ok: true, artifactId: artifact.id, pinned: false });
  } finally {
    await rm(artifact.filePath, { force: true });
    await rm(outputDir, { recursive: true, force: true });
    await server.close();
  }
});

test('artifact pinning requires storage permission and project access', async () => {
  const { server } = await signIn();
  const managerId = `github:artifact-pin-manager-${crypto.randomUUID()}`;
  const readerId = `github:artifact-pin-reader-${crypto.randomUUID()}`;
  const managerPermissions = PermissionFlag.requestDecrypt | PermissionFlag.manageAutomation;
  const readerPermissions = PermissionFlag.requestDecrypt;
  const managerRole = createRole({ name: `Artifact storage manager ${crypto.randomUUID()}`, color: '#5865f2', permissions: serializeBits(managerPermissions) }, 'root');
  const readerRole = createRole({ name: `Artifact reader ${crypto.randomUUID()}`, color: '#3498db', permissions: serializeBits(readerPermissions) }, 'root');
  addAllowedUser(managerId, [managerRole.id], 'root');
  addAllowedUser(readerId, [readerRole.id], 'root');
  const managerCookie = createSessionCookie(managerId, managerPermissions);
  const readerCookie = createSessionCookie(readerId, readerPermissions);
  const project = createProject({ name: `Artifact pin scope ${crypto.randomUUID()}` }, 'root').project!;
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-pin-scope-'));
  const stagingPath = path.join(outputDir, 'restricted.ipa');
  await writeFile(stagingPath, 'restricted ipa');
  const artifact = await promoteArtifact({
    key: `test-pin-scope-${crypto.randomUUID()}`,
    bundleId: 'com.example.pin-scope',
    channel: 'appstore',
    projectId: project.id,
    stagingPath,
  });

  try {
    const outOfProject = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/artifacts/${artifact.id}/pin`,
      headers: { cookie: managerCookie },
      payload: { pinned: true },
    });
    const missingPermission = await server.inject({
      method: 'PUT',
      url: `/v1/dashboard/artifacts/${artifact.id}/pin`,
      headers: { cookie: readerCookie },
      payload: { pinned: true },
    });
    expect(outOfProject.statusCode).toBe(404);
    expect(missingPermission.statusCode).toBe(403);
  } finally {
    await rm(artifact.filePath, { force: true });
    await rm(outputDir, { recursive: true, force: true });
    await server.close();
  }
});

test('audit cursors keep their boundary when a newer audit event is recorded', async () => {
  const { server, cookie } = await signIn();
  const targetPrefix = `cursor-audit-${crypto.randomUUID()}`;
  recordAudit('root', 'settings.update', `${targetPrefix}-older`);
  await Bun.sleep(2);
  recordAudit('root', 'settings.update', `${targetPrefix}-current`);

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/audit-log?limit=1',
      headers: { cookie },
    });
    const first = firstResponse.json() as { entries: { id: string; target: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.entries[0].target).toBe(`${targetPrefix}-current`);
    expect(first.nextCursor).toEqual(expect.any(String));

    const expectedNextResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/audit-log?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const expectedNext = expectedNextResponse.json() as { entries: { id: string }[] };

    await Bun.sleep(2);
    recordAudit('root', 'settings.update', `${targetPrefix}-new`);
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/audit-log?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { entries: { id: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.entries.map((entry) => entry.id)).toEqual(expectedNext.entries.map((entry) => entry.id));
  } finally {
    await server.close();
  }
});

test('device activity cursors keep their boundary when a newer event is recorded', async () => {
  const { server, cookie } = await signIn();
  const createdResponse = await server.inject({
    method: 'POST',
    url: '/v1/dashboard/devices',
    headers: { cookie },
    payload: { name: `Cursor device ${crypto.randomUUID()}`, transport: 'wifi', host: '192.0.2.15', port: 22, user: 'mobile' },
  });
  const device = createdResponse.json() as { id: string };
  recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: 'older cursor event' });
  await Bun.sleep(2);
  recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: 'current cursor event' });

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/devices/${device.id}/activity?limit=1`,
      headers: { cookie },
    });
    const first = firstResponse.json() as { activity: { id: string; message: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.activity[0].message).toBe('current cursor event');
    expect(first.nextCursor).toEqual(expect.any(String));

    const expectedNextResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/devices/${device.id}/activity?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const expectedNext = expectedNextResponse.json() as { activity: { id: string; message: string }[] };

    await Bun.sleep(2);
    recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: 'new cursor event' });
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/devices/${device.id}/activity?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { activity: { id: string; message: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.activity.map((entry) => entry.id)).toEqual(expectedNext.activity.map((entry) => entry.id));
    expect(second.activity[0].message).toBe('older cursor event');
  } finally {
    await server.inject({ method: 'DELETE', url: `/v1/dashboard/devices/${device.id}`, headers: { cookie } });
    await server.close();
  }
});

test('TestFlight subscription cursors keep their boundary when a newer request arrives', async () => {
  const { server, cookie } = await signIn();
  const invitePrefix = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
  const subscriptionInput = (suffix: string) => ({
    url: `https://testflight.apple.com/join/${invitePrefix}${suffix}`,
    inviteCode: `${invitePrefix}${suffix}`,
    requestedBy: 'root',
    status: 'denied' as const,
    bundleId: `com.example.cursor.${suffix}`,
    displayName: `Cursor ${suffix}`,
  });
  const older = createTestFlightSubscription(subscriptionInput('old'), 'root');
  await Bun.sleep(2);
  const current = createTestFlightSubscription(subscriptionInput('now'), 'root');
  let newestId = '';

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/testflight/subscriptions?limit=1',
      headers: { cookie },
    });
    const first = firstResponse.json() as { subscriptions: { id: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.subscriptions[0].id).toBe(current.id);
    expect(first.nextCursor).toEqual(expect.any(String));

    await Bun.sleep(2);
    newestId = createTestFlightSubscription(subscriptionInput('new'), 'root').id;
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/testflight/subscriptions?limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { subscriptions: { id: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.subscriptions.map((subscription) => subscription.id)).toEqual([older.id]);
    expect(second.subscriptions.map((subscription) => subscription.id)).not.toContain(current.id);
  } finally {
    withdrawTestFlightSubscription(older.id, 'root');
    withdrawTestFlightSubscription(current.id, 'root');
    if (newestId) withdrawTestFlightSubscription(newestId, 'root');
    await server.close();
  }
});

test('log cursors keep their boundary when a newer log entry is recorded', async () => {
  const { server, cookie } = await signIn();
  const scope = `cursor-${crypto.randomUUID()}`;
  const logger = scopedLogger(scope);
  logger.info('older cursor log');
  await Bun.sleep(2);
  logger.info('current cursor log');

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/logs?scope=${encodeURIComponent(scope)}&limit=1`,
      headers: { cookie },
    });
    const first = firstResponse.json() as { logs: { id: string; message: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.logs[0].message).toBe('current cursor log');
    expect(first.nextCursor).toEqual(expect.any(String));

    await Bun.sleep(2);
    logger.info('new cursor log');
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/dashboard/logs?scope=${encodeURIComponent(scope)}&limit=1&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { logs: { id: string; message: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.logs[0].message).toBe('older cursor log');
    expect(second.logs.map((entry) => entry.id)).not.toContain(first.logs[0].id);
  } finally {
    await server.close();
  }
});

test('billing subscription cursors keep their boundary when subscriptions change between pages', async () => {
  const { server, cookie } = await signIn();
  const previousSnapshot = exportBillingSnapshot();
  const idPrefix = `cursor-billing-${crypto.randomUUID()}`;
  const baseTime = Date.now() - 10_000;
  const subscription = (suffix: string, at: number) => ({
    provider: 'nowpayments' as const,
    subscriptionId: `${idPrefix}-${suffix}`,
    customerId: `${idPrefix}-customer`,
    userId: 'root',
    status: 'active',
    planId: 'regular' as const,
    priceId: `${idPrefix}-price`,
    productId: 'dkrypt-regular',
    occurredAt: new Date(at).toISOString(),
    updatedAt: new Date(at).toISOString(),
  });
  const current = subscription('current', baseTime);
  const older = subscription('older', baseTime - 1_000);
  upsertBillingSubscription(current);
  upsertBillingSubscription(older);

  try {
    const firstResponse = await server.inject({
      method: 'GET',
      url: `/v1/billing/subscriptions?limit=1&q=${encodeURIComponent(idPrefix)}`,
      headers: { cookie },
    });
    const first = firstResponse.json() as { subscriptions: { subscriptionId: string }[]; nextCursor?: string };
    expect(firstResponse.statusCode).toBe(200);
    expect(first.subscriptions[0].subscriptionId).toBe(current.subscriptionId);
    expect(first.nextCursor).toEqual(expect.any(String));

    upsertBillingSubscription(subscription('new', baseTime + 1_000));
    upsertBillingSubscription(subscription('older', baseTime + 2_000));
    const secondResponse = await server.inject({
      method: 'GET',
      url: `/v1/billing/subscriptions?limit=1&q=${encodeURIComponent(idPrefix)}&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      headers: { cookie },
    });
    const second = secondResponse.json() as { subscriptions: { subscriptionId: string }[] };

    expect(secondResponse.statusCode).toBe(200);
    expect(second.subscriptions.map((entry) => entry.subscriptionId)).toEqual([older.subscriptionId]);
  } finally {
    replaceBillingSnapshot(previousSnapshot);
    await server.close();
  }
});
