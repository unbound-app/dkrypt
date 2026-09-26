import { readStateCollection, replaceStateCollection } from '#store/sqlite.js';
import { isArtifactRecord, type ArtifactRecord } from '#artifactTypes.js';
import type { Database } from 'bun:sqlite';

export interface ArtifactRepository {
  load(): ArtifactRecord[];
  replace(artifacts: Iterable<ArtifactRecord>): void;
  findById(id: string): ArtifactRecord | undefined;
  findByKey(key: string): ArtifactRecord | undefined;
  findBySourceJobId(jobId: string): ArtifactRecord | undefined;
  close(): void;
}

function findArtifact(database: Database, field: 'id' | 'artifact_key' | 'source_job_id', value: string): ArtifactRecord | undefined {
  const row = database.query(`
    SELECT payload
    FROM artifacts
    WHERE ${field} = ?
    ORDER BY updated_at DESC
    LIMIT 1;
  `).get(value) as { payload?: string } | null;
  if (!row?.payload) return undefined;
  const artifact: unknown = JSON.parse(row.payload);
  return isArtifactRecord(artifact) ? artifact : undefined;
}

export function createArtifactRepository(database: Database): ArtifactRepository {
  return {
    load: () => readStateCollection(database, 'artifacts').filter(isArtifactRecord),
    replace(artifacts) {
      const values = [...artifacts];
      replaceStateCollection(database, 'artifacts', values.map((artifact) => ({
        id: artifact.id,
        payload: artifact,
        updatedAt: artifact.lastAccessedAt,
      })));
    },
    findById: (id) => findArtifact(database, 'id', id),
    findByKey: (key) => findArtifact(database, 'artifact_key', key),
    findBySourceJobId: (jobId) => findArtifact(database, 'source_job_id', jobId),
    close: () => database.close(),
  };
}
