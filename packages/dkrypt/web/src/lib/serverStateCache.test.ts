import { expect, test } from 'bun:test';
import { mergeServerPage, ServerQueryCancelledError, ServerStateCache, serverQueryStatus } from '#lib/serverStateCache.svelte';

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function waitFor(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

test('server query cache deduplicates concurrent loads and reuses fresh typed data', async () => {
  const cache = new ServerStateCache();
  let calls = 0;
  let finishLoad!: (value: { jobs: number }) => void;
  const loader = () => {
    calls += 1;
    return new Promise<{ jobs: number }>((resolve) => {
      finishLoad = resolve;
    });
  };

  const first = cache.query('/v1/dashboard/jobs?projectId=default', loader, 10_000);
  const second = cache.query('/v1/dashboard/jobs?projectId=default', loader, 10_000);
  await nextTurn();
  expect(calls).toBe(1);
  finishLoad({ jobs: 3 });

  await expect(first).resolves.toEqual({ jobs: 3 });
  await expect(second).resolves.toEqual({ jobs: 3 });
  await expect(cache.query('/v1/dashboard/jobs?projectId=default', loader, 10_000)).resolves.toEqual({ jobs: 3 });
  expect(calls).toBe(1);
});

test('invalidating a query prefix refetches active subscribers with fresh data', async () => {
  const cache = new ServerStateCache();
  let calls = 0;
  const snapshots: Array<{ data: number | undefined; isFetching: boolean; isStale: boolean }> = [];
  const loader = async () => ++calls;
  const unsubscribe = cache.observe(
    '/v1/dashboard/jobs?projectId=default',
    loader,
    (snapshot) => snapshots.push({ data: snapshot.data, isFetching: snapshot.isFetching, isStale: snapshot.isStale }),
    10_000,
  );

  await cache.query('/v1/dashboard/jobs?projectId=default', loader, 10_000);
  expect(cache.getSnapshot<number>('/v1/dashboard/jobs?projectId=default').data).toBe(1);
  cache.invalidatePrefix('/v1/dashboard/jobs');
  await cache.query('/v1/dashboard/jobs?projectId=default', loader, 10_000);

  expect(calls).toBe(2);
  expect(snapshots.some((snapshot) => snapshot.isStale)).toBe(true);
  expect(cache.getSnapshot<number>('/v1/dashboard/jobs?projectId=default')).toMatchObject({ data: 2, isFetching: false, isStale: false });
  unsubscribe();
});

test('failed refresh retains the last successful result and marks it stale', async () => {
  const cache = new ServerStateCache();
  const key = '/v1/dashboard/artifacts?projectId=default';
  await cache.query(key, async () => ['artifact.ipa'], 10_000);
  cache.invalidatePrefix(key);

  await expect(cache.query(key, async () => { throw new Error('offline'); }, 10_000)).rejects.toThrow('offline');

  expect(cache.getSnapshot<string[]>(key)).toMatchObject({
    data: ['artifact.ipa'],
    error: new Error('offline'),
    isFetching: false,
    isStale: true,
  });
});

test('clearing the cache during an in-flight request prevents old-account data from returning', async () => {
  const cache = new ServerStateCache();
  let finishLoad!: (value: string[]) => void;
  const pending = cache.query('/v1/dashboard/jobs?projectId=private', () => new Promise<string[]>((resolve) => {
    finishLoad = resolve;
  }), 10_000);
  await nextTurn();
  cache.clear();
  finishLoad(['private-job']);

  await expect(pending).rejects.toBeInstanceOf(ServerQueryCancelledError);
  expect(cache.getSnapshot<string[]>('/v1/dashboard/jobs?projectId=private')).toMatchObject({
    data: undefined,
    isFetching: false,
    isStale: true,
  });
});

test('clearing the cache cancels a queued fresh-cache delivery', async () => {
  const cache = new ServerStateCache();
  await cache.query('/v1/dashboard/jobs?projectId=private', async () => ['private-job'], 10_000);
  const pending = cache.query('/v1/dashboard/jobs?projectId=private', async () => ['new-job'], 10_000);
  cache.clear();

  await expect(pending).rejects.toBeInstanceOf(ServerQueryCancelledError);
});

test('a response started before invalidation cannot replace newer server data', async () => {
  const cache = new ServerStateCache();
  const results: Array<(value: number) => void> = [];
  let calls = 0;
  const loader = () => {
    calls += 1;
    return new Promise<number>((resolve) => results.push(resolve));
  };
  const unsubscribe = cache.observe('/v1/dashboard/jobs?projectId=default', loader, () => {}, 10_000);
  await nextTurn();
  cache.invalidatePrefix('/v1/dashboard/jobs');
  await nextTurn();

  expect(calls).toBe(2);
  results[1](2);
  await nextTurn();
  results[0](1);
  await nextTurn();

  expect(cache.getSnapshot<number>('/v1/dashboard/jobs?projectId=default')).toMatchObject({
    data: 2,
    isFetching: false,
    isStale: false,
  });
  unsubscribe();
});

test('prefix invalidation respects route boundaries', async () => {
  const cache = new ServerStateCache();
  let matchingLoads = 0;
  let unrelatedLoads = 0;
  const stopMatching = cache.observe('/v1/dashboard/jobs?projectId=default', async () => ++matchingLoads, () => {}, 10_000);
  const stopUnrelated = cache.observe('/v1/dashboard/jobs-old?projectId=default', async () => ++unrelatedLoads, () => {}, 10_000);
  await nextTurn();

  cache.invalidatePrefix('/v1/dashboard/jobs');
  await nextTurn();

  expect(matchingLoads).toBe(2);
  expect(unrelatedLoads).toBe(1);
  stopMatching();
  stopUnrelated();
});

test('least-recently-used inactive queries are evicted at the cache limit', async () => {
  const cache = new ServerStateCache(2);
  await cache.query('a', async () => 1, 10_000);
  await cache.query('b', async () => 2, 10_000);
  await cache.query('a', async () => 10, 10_000);
  await cache.query('c', async () => 3, 10_000);

  expect(cache.getSnapshot<number>('a').data).toBe(1);
  expect(cache.getSnapshot<number>('b').data).toBeUndefined();
  expect(cache.getSnapshot<number>('c').data).toBe(3);
});

test('active observers are notified when cached data reaches its stale time', async () => {
  const cache = new ServerStateCache();
  const snapshots: Array<{ data: number | undefined; isStale: boolean }> = [];
  const stop = cache.observe('short-lived', async () => 4, (snapshot) => {
    snapshots.push({ data: snapshot.data, isStale: snapshot.isStale });
  }, 10);
  await cache.query('short-lived', async () => 5, 10);
  await waitFor(20);

  expect(snapshots).toContainEqual({ data: 4, isStale: true });
  stop();
});

test('query status distinguishes cached refresh, stale data, and refresh failure', () => {
  expect(serverQueryStatus({ data: [], error: undefined, isFetching: true, isStale: true })).toBe('Refreshing saved results…');
  expect(serverQueryStatus({ data: [], error: undefined, isFetching: false, isStale: true })).toBe('Saved results may be out of date.');
  expect(serverQueryStatus({ data: [], error: new Error('offline'), isFetching: false, isStale: true })).toBe('Refresh failed. Showing the last saved results.');
  expect(serverQueryStatus({ data: undefined, error: new Error('offline'), isFetching: false, isStale: true })).toBe('');
});

test('refreshing a query preserves previously loaded pages without duplicates', () => {
  const oldItems = [{ id: 'new' }, { id: 'middle' }, { id: 'old' }];
  const refreshedPage = [{ id: 'latest' }, { id: 'new' }];

  expect(mergeServerPage(refreshedPage, oldItems, 'same', 'same')).toEqual([
    { id: 'latest' },
    { id: 'new' },
    { id: 'middle' },
    { id: 'old' },
  ]);
  expect(mergeServerPage(refreshedPage, oldItems, 'previous', 'changed')).toEqual(refreshedPage);
});
