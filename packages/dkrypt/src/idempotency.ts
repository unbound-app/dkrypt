import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '#config.js';
import { openStateCollectionDatabase, readStateCollection, replaceStateCollection } from '#store/sqlite.js';

export interface IdempotencyRecord {
  scope: string;
  key: string;
  fingerprint: string;
  jobId: string;
  expiresAt: number;
}

export class IdempotencyRegistry {
  private readonly records = new Map<string, IdempotencyRecord>();

  constructor(records: IdempotencyRecord[] = [], private readonly persist?: (records: IdempotencyRecord[]) => void) {
    for (const record of records) this.records.set(`${record.scope}:${record.key}`, record);
  }

  lookup(scope: string, key: string, fingerprint: string, now = Date.now()): { jobId?: string; conflict: boolean } {
    const id = `${scope}:${key}`;
    const record = this.records.get(id);
    if (!record) return { conflict: false };
    if (record.expiresAt <= now) {
      this.records.delete(id);
      this.save();
      return { conflict: false };
    }
    if (record.fingerprint !== fingerprint) return { conflict: true };
    return { jobId: record.jobId, conflict: false };
  }

  record(scope: string, key: string, fingerprint: string, jobId: string, ttlMs: number, now = Date.now()): void {
    this.records.set(`${scope}:${key}`, { scope, key, fingerprint, jobId, expiresAt: now + ttlMs });
    this.save();
  }

  private save(): void {
    this.persist?.([...this.records.values()]);
  }
}

const registryPath = path.join(config.stateDir, 'idempotency.json');
const registryDatabase = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['idempotency_keys']);

function loadRecords(): IdempotencyRecord[] {
  const databaseRecords = readStateCollection(registryDatabase, 'idempotency_keys');
  if (databaseRecords.length > 0) {
    if (!databaseRecords.every(isIdempotencyRecord)) throw new Error('idempotency database record is malformed');
    return databaseRecords as IdempotencyRecord[];
  }
  if (!existsSync(registryPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isIdempotencyRecord)) throw new Error('idempotency JSON snapshot is malformed');
    const records = parsed as IdempotencyRecord[];
    replaceStateCollection(registryDatabase, 'idempotency_keys', records.map((record) => ({ id: `${record.scope}:${record.key}`, payload: record, updatedAt: record.expiresAt })));
    return records;
  } catch (error) {
    throw new Error(`could not initialize idempotency state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isIdempotencyRecord(value: unknown): value is IdempotencyRecord {
  return typeof value === 'object' && value !== null && typeof (value as IdempotencyRecord).scope === 'string' && typeof (value as IdempotencyRecord).key === 'string' && typeof (value as IdempotencyRecord).fingerprint === 'string' && typeof (value as IdempotencyRecord).jobId === 'string' && typeof (value as IdempotencyRecord).expiresAt === 'number';
}

function persistRecords(records: IdempotencyRecord[]): void {
  replaceStateCollection(registryDatabase, 'idempotency_keys', records.map((record) => ({ id: `${record.scope}:${record.key}`, payload: record, updatedAt: record.expiresAt })));
  mkdirSync(path.dirname(registryPath), { recursive: true });
  const temporaryPath = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(records)}\n`, { mode: 0o600 });
  const descriptor = openSync(temporaryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, registryPath);
}

export const apiIdempotencyRegistry = new IdempotencyRegistry(loadRecords(), persistRecords);

export function closeIdempotencyDatabase(): void {
  registryDatabase.close();
}
