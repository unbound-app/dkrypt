import { describeHttpError } from '#util/httpError.js';

export interface ItunesLookupResult {
  version: string;
  bundleId: string;
  trackId: number;
  fileSizeBytes?: number;
}

export interface ItunesAppMetadata {
  bundleId: string;
  trackId: number;
  trackName: string;
  sellerName: string;
  artworkUrl: string;
  version: string;
  fileSizeBytes?: number;
  category?: string;
  description?: string;
  screenshots?: string[];
  releaseNotes?: string;
  price?: number;
}

interface ItunesLookupResponse {
  resultCount: number;
  results: Array<{
    version: string;
    bundleId: string;
    trackId: number;
    fileSizeBytes?: number;
    trackName?: string;
    sellerName?: string;
    artworkUrl60?: string;
    artworkUrl100?: string;
    artworkUrl512?: string;
    primaryGenreName?: string;
    description?: string;
    screenshotUrls?: string[];
    releaseNotes?: string;
    price?: number;
  }>;
}

function parseFileSizeBytes(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function lookupCurrentVersion(bundleId: string): Promise<ItunesLookupResult> {
  const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(describeHttpError('itunes lookup failed', res));

  const body = (await res.json()) as ItunesLookupResponse;
  const result = body.results[0];
  if (body.resultCount < 1 || !result) throw new Error(`itunes lookup returned no results for ${bundleId}`);

  return {
    version: result.version,
    bundleId: result.bundleId,
    trackId: result.trackId,
    fileSizeBytes: parseFileSizeBytes(result.fileSizeBytes),
  };
}

export async function lookupAppMetadata(bundleId: string): Promise<ItunesAppMetadata> {
  const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(describeHttpError('itunes lookup failed', res));

  const body = (await res.json()) as ItunesLookupResponse;
  const result = body.results[0];
  if (body.resultCount < 1 || !result || !result.trackName) {
    throw new Error(`itunes lookup returned no metadata for ${bundleId}`);
  }

  return {
    bundleId: result.bundleId,
    trackId: result.trackId,
    trackName: result.trackName,
    sellerName: result.sellerName ?? '',
    artworkUrl: result.artworkUrl512 || result.artworkUrl100 || result.artworkUrl60 || '',
    version: result.version,
    fileSizeBytes: parseFileSizeBytes(result.fileSizeBytes),
    category: result.primaryGenreName,
    description: result.description,
    screenshots: result.screenshotUrls?.slice(0, 10),
    releaseNotes: result.releaseNotes,
    price: result.price,
  };
}

export interface ItunesSearchResult {
  bundleId: string;
  trackId: number;
  trackName: string;
  version: string;
  sellerName: string;
  artworkUrl: string;
  price: number;
  category?: string;
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
    primaryGenreName?: string;
  }>;
}

export async function searchApps(term: string, limit = 10): Promise<ItunesSearchResult[]> {
  const url = `https://itunes.apple.com/search?entity=software&limit=${limit}&term=${encodeURIComponent(term)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(describeHttpError('itunes search failed', res));

  const body = (await res.json()) as ItunesSearchResponse;
  return body.results.map((r) => ({
    bundleId: r.bundleId,
    trackId: r.trackId,
    trackName: r.trackName,
    version: r.version,
    sellerName: r.sellerName,
    artworkUrl: r.artworkUrl100 || r.artworkUrl60 || '',
    price: r.price,
    category: r.primaryGenreName,
  }));
}
