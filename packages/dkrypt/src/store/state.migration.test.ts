import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStateDatabase, readStateCollection } from '#store/sqlite.js';

describe('state migrations', () => {
  test('removes v13 share records and obsolete permission bits', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-state-migration-'));
    const obsoletePermissions = (1n << 10n).toString();
    await writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        version: 13,
        backupHistory: [{ id: 'legacy-backup', createdAt: 5, sizeBytes: 10, filename: 'backup.json', trigger: 'manual' }],
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
          STATE_DATABASE_FILE: 'state.sqlite',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (exitCode !== 0) throw new Error(`state migration failed: ${stderr}`);

    const migrated = JSON.parse(await readFile(path.join(stateDir, 'state.json'), 'utf8')) as {
      version: number;
      roles: Array<{ id: string; permissions: string; isDefault: boolean }>;
      projects: Array<{ id: string; isDefault: boolean }>;
      jobHistory: Array<{ id: string; projectId?: string }>;
      backupHistory: Array<{ id: string; restoreDrillStatus: string }>;
      shareLinks?: unknown;
    };
    expect(migrated.version).toBe(18);
    expect(migrated.roles[0]?.permissions).toBe('0');
    expect(migrated.roles).toEqual([expect.objectContaining({ id: 'legacy', isDefault: false, permissions: '0' })]);
    expect(migrated.projects).toContainEqual(expect.objectContaining({ id: 'default', isDefault: true }));
    expect(migrated.jobHistory).toContainEqual(expect.objectContaining({ id: 'legacy-job', projectId: 'default' }));
    expect(migrated.backupHistory).toContainEqual(expect.objectContaining({ id: 'legacy-backup', restoreDrillStatus: 'not_run' }));
    expect(migrated.shareLinks).toBeUndefined();

    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      expect(readStateCollection(database.db, 'projects')).toContainEqual(expect.objectContaining({ id: 'default', isDefault: true }));
    } finally {
      database.close();
    }
  });

  test('preserves valid v6 accounts that use the viewer permission default', async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-state-v6-account-'));
    const statePath = path.join(stateDir, 'state.json');
    await writeFile(statePath, JSON.stringify({ version: 6, allowedUsers: [{ username: 'legacy-viewer', addedAt: 1 }] }));

    try {
      const child = Bun.spawn(
        [process.execPath, '-e', "await import('./src/store/state.ts')"],
        {
          cwd: process.cwd(),
          env: {
            API_KEY: 'state-v6-account-api-key',
            SESSION_SIGNING_SECRET: 'state-v6-account-session-secret',
            ADMIN_PASSWORD: 'state-v6-account-admin-password',
            STATE_DIR: stateDir,
            STATE_DATABASE_FILE: 'state.sqlite',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      if (exitCode !== 0) throw new Error(`valid v6 account migration failed: ${stderr}`);

      const migrated = JSON.parse(await readFile(statePath, 'utf8')) as { allowedUsers: Array<{ username: string; roleIds: string[]; addedAt: number }> };
      expect(migrated.allowedUsers).toEqual([{ username: 'legacy-viewer', roleIds: [], addedAt: 1 }]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('fails closed on malformed account and role collections without rewriting the legacy state file', async () => {
    const invalidRole = { id: 'legacy-role', name: 'Legacy', color: '#000000', permissions: 'not-a-bitfield', position: 0, isDefault: false, createdAt: 1, updatedAt: 1 };
    const malformedStates = [
      { version: 1, allowedUsers: 'lost-users' },
      { version: 1, allowedUsers: [{ username: 'lost-user' }] },
      { version: 1, roles: 'lost-roles' },
      { version: 2, allowedUsers: 'lost-users' },
      { version: 3, allowedUsers: 'lost-users' },
      { version: 4, allowedUsers: 'lost-users' },
      { version: 5, allowedUsers: 'lost-users' },
      { version: 6, allowedUsers: 'lost-users' },
      { version: 6, allowedUsers: [{ username: 'escalated-user', addedAt: 1, permissions: [] }] },
      { version: 6, allowedUsers: [{ username: 'escalated-user', addedAt: 1, permissions: {} }] },
      { version: 7, roles: 'lost-roles' },
      { version: 8, roles: 'lost-roles' },
      { version: 9, roles: 'lost-roles' },
      { version: 7, roles: [invalidRole] },
      { version: 8, roles: [invalidRole] },
      { version: 9, roles: [invalidRole] },
      { version: 13, roles: [invalidRole] },
      { version: 18, allowedUsers: { username: 'lost-user' }, roles: [] },
      { version: 18, allowedUsers: [], roles: 'lost-role' },
    ];

    for (const [index, malformedState] of malformedStates.entries()) {
      const stateDir = await mkdtemp(path.join(tmpdir(), `dkrypt-state-malformed-accounts-${index}-`));
      const source = JSON.stringify(malformedState);
      const statePath = path.join(stateDir, 'state.json');
      await writeFile(statePath, source);

      try {
        const child = Bun.spawn(
          [process.execPath, '-e', "await import('./src/store/state.ts')"],
          {
            cwd: process.cwd(),
            env: {
              API_KEY: 'state-malformed-api-key',
              SESSION_SIGNING_SECRET: 'state-malformed-session-secret',
              ADMIN_PASSWORD: 'state-malformed-admin-password',
              STATE_DIR: stateDir,
              STATE_DATABASE_FILE: 'state.sqlite',
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

        expect(exitCode).not.toBe(0);
        expect(stderr).toMatch(/persistent (account|role|account or role) data (is malformed|has no supported migration)/);
        expect(await readFile(statePath, 'utf8')).toBe(source);
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }
  });
});
