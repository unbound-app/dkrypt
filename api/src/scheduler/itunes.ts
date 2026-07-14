interface ItunesLookupResult {
  version: string;
  bundleId: string;
}

interface ItunesLookupResponse {
  resultCount: number;
  results: Array<{ version: string; bundleId: string }>;
}

export async function lookupCurrentVersion(bundleId: string): Promise<ItunesLookupResult> {
  const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`itunes lookup failed: HTTP ${res.status}`);

  const body = (await res.json()) as ItunesLookupResponse;
  const result = body.results[0];
  if (body.resultCount < 1 || !result) throw new Error(`itunes lookup returned no results for ${bundleId}`);

  return { version: result.version, bundleId: result.bundleId };
}
