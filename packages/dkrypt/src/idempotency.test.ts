import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createIdempotencyRepository } from '#store/idempotencyRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { IdempotencyRegistry, type IdempotencyRecord } from '#idempotency.js';

function createIdempotencyRecord(overrides: Partial<IdempotencyRecord> = {}): IdempotencyRecord {
  return {
    scope: 'key-1',
    key: 'retry-1',
    fingerprint: 'request-a',
    jobId: 'job-1',
    expiresAt: 1_000,
    ...overrides,
  };
}

async function withIdempotencyRepository(
  testName: string,
  run: (openRepository: () => ReturnType<typeof createIdempotencyRepository>) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(path.join(tmpdir(), `dkrypt-idempotency-${testName}-`));
  const options = { stateDir, filename: 'state.sqlite' };
  let repository: ReturnType<typeof createIdempotencyRepository> | undefined;
  const openRepository = () => {
    repository?.close();
    repository = createIdempotencyRepository(openStateCollectionDatabase(options, ['idempotency_keys']));
    return repository;
  };

  try {
    await run(openRepository);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('IdempotencyRegistry returns the original job for an equivalent retry and rejects changed input', () => {
  const registry = new IdempotencyRegistry();
  registry.record('key-1', 'retry-1', 'request-a', 'job-1', 1_000, 10);

  expect(registry.lookup('key-1', 'retry-1', 'request-a', 11)).toEqual({ jobId: 'job-1', conflict: false });
  expect(registry.lookup('key-1', 'retry-1', 'request-b', 11)).toEqual({ conflict: true });
  expect(registry.lookup('key-1', 'retry-1', 'request-a', 1_010)).toEqual({ conflict: false });
});

test('idempotency records survive a database restart without replacing other keys', async () => {
  await withIdempotencyRepository('repository', async (openRepository) => {
    const repository = openRepository();
    const first = createIdempotencyRecord();
    const second = createIdempotencyRecord({ key: 'retry-2', fingerprint: 'request-b', jobId: 'job-2' });
    repository.save(first);
    repository.save(second);
    repository.save({ ...first, fingerprint: 'request-c', jobId: 'job-3', expiresAt: 2_000 });
    expect(repository.find('key-1', 'retry-1')).toEqual({ ...first, fingerprint: 'request-c', jobId: 'job-3', expiresAt: 2_000 });
    expect(repository.list()).toEqual([{ ...first, fingerprint: 'request-c', jobId: 'job-3', expiresAt: 2_000 }, second]);

    const restartedRepository = openRepository();
    expect(restartedRepository.find('key-1', 'retry-1')).toEqual({ ...first, fingerprint: 'request-c', jobId: 'job-3', expiresAt: 2_000 });
    expect(restartedRepository.list()).toHaveLength(2);
  });
});

test('IdempotencyRegistry resolves retries from persistent storage after restart', async () => {
  await withIdempotencyRepository('registry-restart', async (openRepository) => {
    const repository = openRepository();
    const firstProcess = new IdempotencyRegistry(repository);
    firstProcess.record('key-1', 'retry-1', 'request-a', 'job-1', 1_000, 10);

    const restartedProcess = new IdempotencyRegistry(openRepository());
    expect(restartedProcess.lookup('key-1', 'retry-1', 'request-a', 11)).toEqual({ jobId: 'job-1', conflict: false });
    expect(restartedProcess.lookup('key-1', 'retry-1', 'request-b', 11)).toEqual({ conflict: true });
  });
});

test('legacy idempotency data is imported once and is not restored after cleanup', async () => {
  const legacyRecord = createIdempotencyRecord({ fingerprint: 'legacy-request', jobId: 'legacy-job' });
  const additionalRecord = createIdempotencyRecord({ key: 'retry-2', jobId: 'job-2' });

  await withIdempotencyRepository('legacy-import', async (openRepository) => {
    const repository = openRepository();
    expect(repository.importLegacySnapshot(() => [legacyRecord, additionalRecord])).toBe(true);
    expect(repository.find('key-1', 'retry-1')).toEqual(legacyRecord);
    expect(repository.find('key-1', 'retry-2')).toEqual(additionalRecord);
    repository.delete('key-1', 'retry-1');
    repository.delete('key-1', 'retry-2');

    const restartedRepository = openRepository();
    expect(restartedRepository.importLegacySnapshot(() => { throw new Error('legacy snapshot should not be read'); })).toBe(false);
    expect(restartedRepository.list()).toEqual([]);
  });
});

test('legacy idempotency data does not overwrite or supplement a populated database', async () => {
  const legacyRecord = createIdempotencyRecord({ fingerprint: 'legacy-request', jobId: 'legacy-job' });
  const currentRecord = createIdempotencyRecord({ fingerprint: 'current-request', jobId: 'current-job' });
  const additionalRecord = createIdempotencyRecord({ key: 'retry-2', jobId: 'job-2' });

  await withIdempotencyRepository('legacy-precedence', async (openRepository) => {
    const repository = openRepository();
    repository.save(currentRecord);
    let legacyLoaderCalled = false;
    expect(repository.importLegacySnapshot(() => {
      legacyLoaderCalled = true;
      return [legacyRecord, additionalRecord];
    })).toBe(true);
    expect(legacyLoaderCalled).toBe(false);
    expect(repository.find('key-1', 'retry-1')).toEqual(currentRecord);
    expect(repository.find('key-1', 'retry-2')).toBeUndefined();
  });
});
