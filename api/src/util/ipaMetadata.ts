import AdmZip from 'adm-zip';
import { parseBuffer as parseBinaryPlist } from 'bplist-parser';
import { parse as parseXmlPlist } from 'plist';
import type { IpaMetadata } from '../store/state.js';

export interface ExtractedIpaMetadata {
  summary: IpaMetadata;
  infoPlist: Record<string, unknown>;
}

const BPLIST_MAGIC = Buffer.from('bplist00', 'utf8');

function parsePlistBuffer(buf: Buffer): Record<string, unknown> {
  if (buf.subarray(0, 8).equals(BPLIST_MAGIC)) {
    const [parsed] = parseBinaryPlist(buf) as Record<string, unknown>[];
    return parsed ?? {};
  }
  return parseXmlPlist(buf.toString('utf8')) as Record<string, unknown>;
}

// Only primitive-valued keys are kept - arrays, nested dicts, dates and binary Data entries
// aren't diff-interesting for the version-diff feature and would bloat persisted job history.
function sanitizeInfoPlist(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

// Reads Payload/<App>.app/Info.plist directly out of a finished .ipa (a zip archive) without
// shelling out to unzip - the file is only guaranteed to exist on disk for a short window
// (until the TTL sweeper reclaims it), so this runs synchronously right after a decrypt finishes.
export async function extractIpaMetadata(ipaPath: string): Promise<ExtractedIpaMetadata> {
  const zip = new AdmZip(ipaPath);
  const entry = zip.getEntries().find((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.entryName));
  if (!entry) throw new Error('Info.plist not found in Payload/*.app');

  const raw = parsePlistBuffer(entry.getData());
  const infoPlist = sanitizeInfoPlist(raw);

  return {
    summary: {
      bundleVersion: typeof raw.CFBundleVersion === 'string' ? raw.CFBundleVersion : undefined,
      shortVersion: typeof raw.CFBundleShortVersionString === 'string' ? raw.CFBundleShortVersionString : undefined,
      minOsVersion: typeof raw.MinimumOSVersion === 'string' ? raw.MinimumOSVersion : undefined,
      executable: typeof raw.CFBundleExecutable === 'string' ? raw.CFBundleExecutable : undefined,
    },
    infoPlist,
  };
}
