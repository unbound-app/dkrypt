import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { dashboardObservabilityRoutes } from '#routes/dashboardObservabilityRoutes.js';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import { recordAudit } from '#store/state.js';
import type { Response } from '#http.js';

function cookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, header: string) => { value = header; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

test('who-changed-this audit view shows only the requested target to authorized managers', async () => {
  const target = randomUUID();
  const other = randomUUID();
  recordAudit('operator-a', 'device.update', target, 'Studio iPad', [{ field: 'enabled', before: true, after: false }]);
  recordAudit('operator-b', 'device.update', other, 'Other iPad');
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(dashboardObservabilityRoutes);
  try {
    const url = `/v1/dashboard/audit-log/target/${target}`;
    const allowed = await server.inject({ method: 'GET', url, headers: { cookie: cookie(PermissionFlag.viewUsers) } });
    const denied = await server.inject({ method: 'GET', url, headers: { cookie: cookie(PermissionFlag.viewDevices) } });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().entries).toMatchObject([{ actor: 'operator-a', target, changes: [{ field: 'enabled', before: true, after: false }] }]);
    expect(allowed.json().entries.some((entry: { target: string }) => entry.target === other)).toBe(false);
    expect(denied.statusCode).toBe(403);
  } finally {
    await server.close();
  }
});
