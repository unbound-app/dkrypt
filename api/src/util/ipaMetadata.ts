import AdmZip from 'adm-zip';
import { parseBuffer as parseBinaryPlist } from 'bplist-parser';
import { parse as parseXmlPlist } from 'plist';
import type { IpaMetadata } from '#store/state.js';

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

function sanitizeInfoPlist(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

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
