import { describe, expect, test } from 'bun:test';

const { lookupAppMetadata, searchApps } = await import(`${new URL('./itunes.ts', import.meta.url).href}?storefront-test`);

const originalFetch = globalThis.fetch;

function mockFetch(requests: URL[]): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    requests.push(url);
    const result = {
      version: '340.0',
      bundleId: 'com.hammerandchisel.discord',
      trackId: 985746746,
      trackName: 'Discord',
      sellerName: 'Discord Inc.',
      artworkUrl100: 'https://example.com/discord.png',
      price: 0,
    };
    const body = { resultCount: 1, results: [result] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

async function runCurrentVersionLookupInIsolatedProcess(): Promise<{ url: string; version: string }> {
  const script = [
    "globalThis.fetch = async (input) => {",
    "  globalThis.requestUrl = String(input);",
    "  return new Response(JSON.stringify({ resultCount: 1, results: [{ version: '340.0', bundleId: 'com.hammerandchisel.discord', trackId: 985746746 }] }), { status: 200 });",
    "};",
    "const { lookupCurrentVersion } = await import('./src/scheduler/itunes.ts');",
    "const result = await lookupCurrentVersion('com.hammerandchisel.discord');",
    "console.log(JSON.stringify({ url: globalThis.requestUrl, version: result.version }));",
  ].join('\n');
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`isolated lookup failed: ${stderr}`);
  return JSON.parse(stdout) as { url: string; version: string };
}

describe('iTunes storefront selection', () => {
  test('uses the US storefront for current version lookup', async () => {
    const result = await runCurrentVersionLookupInIsolatedProcess();
    expect(new URL(result.url).searchParams.get('country')).toBe('US');
    expect(result.version).toBe('340.0');
  });

  test('uses the US storefront for metadata and search', async () => {
    const requests: URL[] = [];
    mockFetch(requests);

    try {
      await lookupAppMetadata('com.hammerandchisel.discord');
      await searchApps('Discord');
      expect(requests).toHaveLength(2);
      expect(requests.every((url) => url.searchParams.get('country') === 'US')).toBe(true);
    } finally {
      restoreFetch();
    }
  });
});
