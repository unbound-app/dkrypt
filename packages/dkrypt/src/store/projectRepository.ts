import type { Database } from 'bun:sqlite';
import type { ProjectRecord } from '#store/state.js';

export interface ProjectRepository {
  listAll(): ProjectRecord[];
  findById(id: string): ProjectRecord | undefined;
  save(project: ProjectRecord): void;
  replaceAll(projects: ProjectRecord[]): void;
}

export function isProjectRecordShape(value: unknown): value is ProjectRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const project = value as Partial<ProjectRecord>;
  return typeof project.id === 'string'
    && project.id.length > 0
    && typeof project.name === 'string'
    && project.name.trim().length > 0
    && Array.isArray(project.memberIds)
    && project.memberIds.every((memberId) => typeof memberId === 'string' && memberId === memberId.toLowerCase())
    && new Set(project.memberIds).size === project.memberIds.length
    && typeof project.isDefault === 'boolean'
    && typeof project.createdBy === 'string'
    && typeof project.createdAt === 'number'
    && typeof project.updatedAt === 'number'
    && (project.archivedAt === undefined || typeof project.archivedAt === 'number')
    && (project.storageQuotaBytes === undefined || (Number.isSafeInteger(project.storageQuotaBytes) && project.storageQuotaBytes > 0))
    && (project.dailyJobQuota === undefined || (Number.isSafeInteger(project.dailyJobQuota) && project.dailyJobQuota > 0))
    && (project.maxConcurrentJobs === undefined || (Number.isSafeInteger(project.maxConcurrentJobs) && project.maxConcurrentJobs > 0));
}

export function createProjectRepository(database: Database): ProjectRepository {
  const listAllQuery = database.query('SELECT payload FROM projects ORDER BY rowid ASC;');
  const findByIdQuery = database.query('SELECT payload FROM projects WHERE id = ?;');
  const deleteAllQuery = database.query('DELETE FROM projects;');
  const insertQuery = database.query(`
    INSERT INTO projects (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
  `);

  function clone(project: ProjectRecord): ProjectRecord {
    return { ...project, memberIds: [...project.memberIds] };
  }

  function parse(payload: string): ProjectRecord {
    const value: unknown = JSON.parse(payload);
    if (!isProjectRecordShape(value)) throw new Error('persisted project record is malformed');
    return clone(value);
  }

  function listAll(): ProjectRecord[] {
    return (listAllQuery.all() as Array<{ payload: string }>).map(({ payload }) => parse(payload));
  }

  function save(project: ProjectRecord): void {
    const copy = clone(project);
    insertQuery.run(copy.id, JSON.stringify(copy), copy.updatedAt);
  }

  function replaceAll(projects: ProjectRecord[]): void {
    database.exec('BEGIN IMMEDIATE;');
    try {
      deleteAllQuery.run();
      for (const project of projects) save(project);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }

  return {
    listAll,
    findById(id) {
      const row = findByIdQuery.get(id) as { payload: string } | null;
      return row ? parse(row.payload) : undefined;
    },
    save,
    replaceAll,
  };
}
