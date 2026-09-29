import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '#config.js';
import { createIdempotencyRepository, idempotencyRecordId, isIdempotencyRecord, type IdempotencyRepository } from '#store/idempotencyRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

export interface IdempotencyRecord {
  scope: string;
  key: string;
  fingerprint: string;
  jobId: string;
  expiresAt: number;
}

function createMemoryIdempotencyRepository(): Pick<IdempotencyRepository, 'find' | 'save' | 'delete'> {
  const records = new Map<string, IdempotencyRecord>();
  return {
    find(scope, key) {
      const record = records.get(idempotencyRecordId(scope, key));
      return record ? { ...record } : undefined;
    },
    save(record) {
      records.set(idempotencyRecordId(record.scope, record.key), { ...record });
    },
    delete(scope, key) {
      records.delete(idempotencyRecordId(scope, key));
    },
  };
}

export class IdempotencyRegistry {
  constructor(private readonly repository: Pick<IdempotencyRepository, 'find' | 'save' | 'delete'> = createMemoryIdempotencyRepository()) {}

  lookup(scope: string, key: string, fingerprint: string, now = Date.now()): { jobId?: string; conflict: boolean } {
    const record = this.repository.find(scope, key);
    if (!record) return { conflict: false };
    if (record.expiresAt <= now) {
      this.repository.delete(scope, key);
      return { conflict: false };
    }
    if (record.fingerprint !== fingerprint) return { conflict: true };
    return { jobId: record.jobId, conflict: false };
  }

  record(scope: string, key: string, fingerprint: string, jobId: string, ttlMs: number, now = Date.now()): void {
    this.repository.save({ scope, key, fingerprint, jobId, expiresAt: now + ttlMs });
  }
}

const registryPath = path.join(config.stateDir, 'idempotency.json');
const registryDatabase = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['idempotency_keys']);
const registryRepository = createIdempotencyRepository(registryDatabase);

function loadLegacyRecords(): IdempotencyRecord[] {
  if (!existsSync(registryPath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isIdempotencyRecord)) throw new Error('idempotency JSON snapshot is malformed');
    return parsed;
  } catch (error) {
    throw new Error(`could not initialize idempotency state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const storedRecords = registryRepository.list();
registryRepository.importLegacySnapshot(() => storedRecords.length === 0 ? loadLegacyRecords() : []);

export const apiIdempotencyRegistry = new IdempotencyRegistry(registryRepository);

export function closeIdempotencyDatabase(): void {
  registryRepository.close();
}
