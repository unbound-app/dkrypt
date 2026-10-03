import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import type { Response } from '#http.js';
import { dashboardWatchRoutes } from '#routes/dashboardWatchRoutes.js';
import { recordWatchRevision } from '#store/watchWorkflowRepository.js';
import type { AppWatch } from '#store/state.js';

function sessionCookie(): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions: PermissionFlag.administrator });
  return value.split(';', 1)[0]!;
}

test('deleted watch revisions remain readable to authorized managers in their project', async () => {
  const watch = { id: randomUUID(), projectId: 'default', bundleId: 'com.example.deleted', pollCron: '0 * * * *', enabled: false, updatedAt: Date.now() } as AppWatch;
  const revision = recordWatchRevision(watch, 'root', 'deleted');
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(dashboardWatchRoutes);
  try {
    const accessible = await server.inject({ method: 'GET', url: `/v1/dashboard/watches/${watch.id}/revisions?projectId=default`, headers: { cookie: sessionCookie() } });
    expect(accessible.statusCode).toBe(200);
    expect(accessible.json().revisions.some((entry: { id: string }) => entry.id === revision.id)).toBe(true);
    const inaccessible = await server.inject({ method: 'GET', url: `/v1/dashboard/watches/${watch.id}/revisions?projectId=other`, headers: { cookie: sessionCookie() } });
    expect(inaccessible.statusCode).toBe(404);
  } finally {
    await server.close();
  }
});
