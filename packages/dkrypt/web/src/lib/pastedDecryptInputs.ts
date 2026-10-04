import { MAX_BATCH_QUEUE_ENTRIES } from './batchQueue';

export type PastedDecryptInput =
  | { kind: 'bundle'; value: string; bundleId: string }
  | { kind: 'appstore'; value: string; trackId: number }
  | { kind: 'testflight'; value: string; url: string }
  | { kind: 'invalid'; value: string; error: string };

const BUNDLE_ID_RE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const APP_STORE_PATH_RE = /(?:^|\/)id([1-9]\d*)(?:\/)?$/;
const TESTFLIGHT_PATH_RE = /^\/join\/([A-Za-z0-9]{1,64})\/?$/;

export function parsePastedDecryptInput(value: string): PastedDecryptInput {
  const trimmed = value.trim();
  if (!trimmed) return { kind: 'invalid', value, error: 'Enter a bundle ID or an Apple link.' };
  if (BUNDLE_ID_RE.test(trimmed) && trimmed.length <= 200) return { kind: 'bundle', value: trimmed, bundleId: trimmed };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { kind: 'invalid', value: trimmed, error: 'Use a bundle ID or an Apple link.' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    return { kind: 'invalid', value: trimmed, error: 'Only secure Apple links are supported.' };
  }
  if (url.hostname === 'apps.apple.com') {
    const match = APP_STORE_PATH_RE.exec(url.pathname);
    const trackId = Number(match?.[1]);
    if (match && Number.isSafeInteger(trackId) && !url.hash) return { kind: 'appstore', value: trimmed, trackId };
  }
  if (url.hostname === 'testflight.apple.com') {
    const match = TESTFLIGHT_PATH_RE.exec(url.pathname);
    if (match && !url.search && !url.hash) {
      const canonical = `https://testflight.apple.com/join/${match[1]}`;
      return { kind: 'testflight', value: trimmed, url: canonical };
    }
  }
  return { kind: 'invalid', value: trimmed, error: 'Use an App Store app link or public TestFlight invite.' };
}

export function parsePastedDecryptInputs(raw: string): { rows: PastedDecryptInput[]; duplicates: string[]; overflow: boolean } {
  const values = raw.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const rows: PastedDecryptInput[] = [];
  for (const value of values.slice(0, MAX_BATCH_QUEUE_ENTRIES)) {
    const row = parsePastedDecryptInput(value);
    const key = row.kind === 'bundle' ? `bundle:${row.bundleId}` : row.kind === 'appstore' ? `appstore:${row.trackId}` : row.kind === 'testflight' ? row.url : `invalid:${row.value}`;
    if (seen.has(key)) {
      duplicates.push(value);
      continue;
    }
    seen.add(key);
    rows.push(row);
  }
  return { rows, duplicates, overflow: values.length > MAX_BATCH_QUEUE_ENTRIES };
}
