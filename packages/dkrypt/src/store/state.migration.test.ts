import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

describe('state migrations', () => {
  test('removes v13 share records and obsolete permission bits', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-state-migration-'));
    const obsoletePermissions = (1n << 10n).toString();
    await writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        version: 13,
        roles: [{ id: 'legacy', name: 'Legacy', color: '#000000', permissions: obsoletePermissions, position: 0, isDefault: false, createdAt: 0, updatedAt: 0 }],
        shareLinks: [{ id: 'old-link', jobId: 'old-job' }],
        jobHistory: [{ id: 'legacy-job', bundleId: 'com.example.legacy', status: 'done', source: 'manual', createdAt: 1, finishedAt: 2 }],
      }),
    );

    const child = Bun.spawn(
      [process.execPath, '-e', "await import('./src/store/state.ts')"],
      {
        cwd: process.cwd(),
        env: {
          API_KEY: 'state-migration-api-key',
          SESSION_SIGNING_SECRET: 'state-migration-session-secret',
          ADMIN_PASSWORD: 'state-migration-admin-password',
          STATE_DIR: stateDir,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (exitCode !== 0) throw new Error(`state migration failed: ${stderr}`);

    const migrated = JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8')) as {
      version: number;
      roles: Array<{ permissions: string }>;
      projects: Array<{ id: string; isDefault: boolean }>;
      jobHistory: Array<{ id: string; projectId?: string }>;
      shareLinks?: unknown;
    };
    expect(migrated.version).toBe(17);
    expect(migrated.roles[0]?.permissions).toBe('0');
    expect(migrated.projects).toContainEqual(expect.objectContaining({ id: 'default', isDefault: true }));
    expect(migrated.jobHistory).toContainEqual(expect.objectContaining({ id: 'legacy-job', projectId: 'default' }));
    expect(migrated.shareLinks).toBeUndefined();
  });
});
