interface SearchResultPresentationInput {
  bundleId: string;
  version: string;
  sellerName: string;
  category?: string;
  testflight?: unknown;
}

export function formatSearchResultMeta(result: SearchResultPresentationInput): string {
  const source = result.testflight ? undefined : result.version ? `v${result.version}` : undefined;
  return [source, result.sellerName, result.category].filter(Boolean).join(' · ');
}

export function shouldShowSearchResultStatus(result: Pick<SearchResultPresentationInput, 'bundleId' | 'testflight'>, statusByBundle: ReadonlyMap<string, string>): boolean {
  return !result.testflight && statusByBundle.has(result.bundleId);
}
