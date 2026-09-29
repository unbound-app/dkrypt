import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStateDatabase } from '#store/sqlite.js';
import { createProjectRepository } from '#store/projectRepository.js';
import type { ProjectRecord } from '#store/state.js';

function project(id: string, name: string, updatedAt: number): ProjectRecord {
  return {
    id,
    name,
    memberIds: [],
    isDefault: id === 'default',
    createdBy: 'root',
    createdAt: updatedAt,
    updatedAt,
  };
}

test('project repository stores canonical records and preserves updates across database reopen', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-project-repository-'));
  const firstDatabase = openStateDatabase({ stateDir });
  const firstRepository = createProjectRepository(firstDatabase.db);
  const defaultProject = project('default', 'Default workspace', 100);
  const initial = project('workspace-a', 'Workspace A', 200);

  try {
    firstRepository.save(defaultProject);
    firstRepository.save(initial);
    firstRepository.save({ ...initial, name: 'Renamed workspace', updatedAt: 300 });

    expect(firstRepository.findById('workspace-a')).toMatchObject({ name: 'Renamed workspace', updatedAt: 300 });
    expect(firstRepository.listAll()).toEqual([defaultProject, { ...initial, name: 'Renamed workspace', updatedAt: 300 }]);
  } finally {
    firstDatabase.close();
  }

  try {
    const reopenedDatabase = openStateDatabase({ stateDir });
    try {
      const reopenedRepository = createProjectRepository(reopenedDatabase.db);
      expect(reopenedRepository.findById('workspace-a')).toMatchObject({ name: 'Renamed workspace', updatedAt: 300 });
      expect(reopenedRepository.listAll().map(({ id }) => id)).toEqual(['default', 'workspace-a']);
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
