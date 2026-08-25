import { expect, test } from 'bun:test';

test('latest App Store resolution uses current App Store metadata without ipadecrypt versions', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('itunes.apple.com/lookup')) {
      return new Response(JSON.stringify({ resultCount: 1, results: [{ version: '342.0', bundleId: 'com.hammerandchisel.discord', trackId: 985746746 }] }), { status: 200 });
    }
    if (url.includes('api.timbrd.com/apple/app-version')) {
      return new Response(JSON.stringify([{ external_identifier: 889467057, bundle_version: '341.0', created_at: '2026-08-12T01:37:23Z' }]), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const { listAppVersions } = await import(`./versions.js?current-app-store-${Date.now()}`);
    const entries = await listAppVersions('com.hammerandchisel.discord');
    expect(entries[0]).toMatchObject({ isLatest: true, displayVersion: '342.0' });
    expect(entries[0]?.externalVersionId).toBeUndefined();
    expect(entries[1]).toMatchObject({ isLatest: false, displayVersion: '341.0', externalVersionId: '889467057' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
