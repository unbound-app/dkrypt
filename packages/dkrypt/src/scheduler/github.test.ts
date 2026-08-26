import { afterEach, describe, expect, test } from 'bun:test';
import { config } from '#config.js';
import { dispatchIpaUpdate, findDispatchedRun, listReleaseVersions, releaseVersionExists } from '#scheduler/github.js';

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

  test('retries a short GitHub 502 burst while finding a workflow run', async () => {
    let calls = 0;
    const run = {
      id: 42,
      status: 'queued',
      conclusion: null,
      created_at: '2026-08-06T00:00:01Z',
      html_url: 'https://github.com/example/app/actions/runs/42',
    };
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls <= 3) return new Response('upstream unavailable', { status: 502 });
      return new Response(JSON.stringify({ workflow_runs: [run] }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(findDispatchedRun('example/app', 'dispatch.yml', new Date('2026-08-06T00:00:00Z'))).resolves.toEqual(run);
    expect(calls).toBe(4);
  });

  test('requests enough workflow runs to find a dispatched run in a busy repository', async () => {
    const runs = Array.from({ length: 11 }, (_, index) => ({
      id: index + 1,
      status: 'queued',
      conclusion: null,
      created_at: `2026-08-06T00:00:${String(index + 1).padStart(2, '0')}Z`,
      html_url: `https://github.com/example/app/actions/runs/${index + 1}`,
    }));
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      const perPage = Number(url.searchParams.get('per_page'));
      return new Response(JSON.stringify({ workflow_runs: runs.slice(0, perPage) }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(findDispatchedRun('example/app', 'dispatch.yml', new Date('2026-08-06T00:00:00Z'))).resolves.toEqual(runs[10]);
  });

  test('treats an exhausted transient workflow-run response as temporarily unavailable', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('upstream unavailable', { status: 502 });
    }) as unknown as typeof fetch;

    await expect(findDispatchedRun('example/app', 'dispatch.yml', new Date('2026-08-06T00:00:00Z'))).resolves.toBeUndefined();
    expect(calls).toBe(4);
  });

  test('does not match a workflow run created before dispatch', async () => {
    const run = {
      id: 43,
      status: 'queued',
      conclusion: null,
      created_at: '2026-08-05T23:59:55Z',
      html_url: 'https://github.com/example/app/actions/runs/43',
    };
    globalThis.fetch = (async () => new Response(JSON.stringify({ workflow_runs: [run] }), { status: 200 })) as unknown as typeof fetch;

    await expect(findDispatchedRun('example/app', 'dispatch.yml', new Date('2026-08-06T00:00:00Z'))).resolves.toBeUndefined();
  });

  test('checks the release tag endpoint when the release list misses a version', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/releases?per_page=100')) {
        return new Response(JSON.stringify([{ tag_name: 'v342.0_108502', created_at: '2026-08-15T00:00:00Z' }]), { status: 200 });
      }
      if (url.endsWith('/releases/tags/v341.0')) {
        return new Response(JSON.stringify({ tag_name: 'v341.0', created_at: '2026-08-11T00:00:00Z' }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    await expect(releaseVersionExists('example/app', '341.0')).resolves.toBe(true);
    expect(urls).toEqual([
      'https://api.github.com/repos/example/app/releases?per_page=100',
      'https://api.github.com/repos/example/app/releases/tags/v341.0',
    ]);
  });

  test('dispatches a stable artifact URL without an expiry token', async () => {
    let payload: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await dispatchIpaUpdate('example/app', 'remote-deploy.yml', `${config.publicBaseUrl}/v1/artifacts/artifact-1/file`, false);

    expect(payload).toMatchObject({
      event_type: 'ipa-update',
      client_payload: {
        ipa_url: `${config.publicBaseUrl}/v1/artifacts/artifact-1/file`,
        is_testflight: false,
      },
    });
    expect(String((payload?.client_payload as Record<string, unknown>)?.ipa_url)).not.toContain('token=');
    expect((payload?.client_payload as Record<string, unknown>)?.dkrypt_base_url).toBeUndefined();
  });
});
