/** Strips a leading "v" (release tags look like "v334.0", iTunes versions look like "334.0"). */
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/** Compares dot-separated numeric version strings. Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const as = normalizeVersion(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const bs = normalizeVersion(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(as.length, bs.length);

  for (let i = 0; i < len; i++) {
    const av = as[i] ?? 0;
    const bv = bs[i] ?? 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }

  return 0;
}
