interface ItunesLookupResult {
  version: string;
  bundleId: string;
  trackId: number;
}

interface ItunesLookupResponse {
  resultCount: number;
  results: Array<{ version: string; bundleId: string; trackId: number }>;
}

export async function lookupCurrentVersion(bundleId: string): Promise<ItunesLookupResult> {
  const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`itunes lookup failed: HTTP ${res.status}`);

  const body = (await res.json()) as ItunesLookupResponse;
  const result = body.results[0];
  if (body.resultCount < 1 || !result) throw new Error(`itunes lookup returned no results for ${bundleId}`);

  return { version: result.version, bundleId: result.bundleId, trackId: result.trackId };
}

export interface ItunesSearchResult {
  bundleId: string;
  trackId: number;
  trackName: string;
  version: string;
  sellerName: string;
  artworkUrl: string;
  price: number;
}

interface ItunesSearchResponse {
  results: Array<{
    bundleId: string;
    trackId: number;
    trackName: string;
    version: string;
    sellerName: string;
    artworkUrl60?: string;
    artworkUrl100?: string;
    price: number;
  }>;
}

export async function searchApps(term: string, limit = 10): Promise<ItunesSearchResult[]> {
  const url = `https://itunes.apple.com/search?entity=software&limit=${limit}&term=${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`itunes search failed: HTTP ${res.status}`);

  const body = (await res.json()) as ItunesSearchResponse;
  return body.results.map((r) => ({
    bundleId: r.bundleId,
    trackId: r.trackId,
    trackName: r.trackName,
    version: r.version,
    sellerName: r.sellerName,
    artworkUrl: r.artworkUrl100 || r.artworkUrl60 || '',
    price: r.price,
  }));
}
