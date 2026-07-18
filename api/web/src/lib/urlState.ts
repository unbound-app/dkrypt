// Small helper for keeping a handful of query params in sync with reactive state, so tabs and
// filters become bookmarkable/shareable links. Always uses replaceState (never pushState) - the
// actual ask is shareable URLs, not browser-back stepping through every tab click/keystroke, and
// replaceState avoids spamming history for that.
export function setQueryParams(patch: Record<string, string | undefined>): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  window.history.replaceState(window.history.state, '', url);
}

export function getQueryParam(key: string): string | undefined {
  return new URL(window.location.href).searchParams.get(key) ?? undefined;
}
