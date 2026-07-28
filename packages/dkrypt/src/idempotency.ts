import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '#config.js';

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

function loadRecords(): IdempotencyRecord[] {
  if (!existsSync(registryPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((record): record is IdempotencyRecord =>
      typeof record?.scope === 'string' &&
      typeof record?.key === 'string' &&
      typeof record?.fingerprint === 'string' &&
      typeof record?.jobId === 'string' &&
      typeof record?.expiresAt === 'number',
    ) : [];
  } catch {
    return [];
  }
}

export const apiIdempotencyRegistry = new IdempotencyRegistry(loadRecords(), (records) => {
  mkdirSync(path.dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(records));
});
