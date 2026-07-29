import { afterEach, describe, expect, test } from 'bun:test';
import { listReleaseVersions } from '#scheduler/github.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GitHub metadata requests', () => {
  test('retries a transient connection failure for release metadata', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) throw new TypeError('The socket connection was closed unexpectedly');
      return new Response(JSON.stringify([{ tag_name: 'v1.2.3', created_at: '2026-07-29T00:00:00Z' }]), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(listReleaseVersions('example/app')).resolves.toEqual(new Set(['1.2.3']));
    expect(calls).toBe(3);
  });
});
