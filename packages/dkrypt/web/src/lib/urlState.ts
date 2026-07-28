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
