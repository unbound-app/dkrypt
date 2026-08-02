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

function architectureName(cputype: number): string {
  return {
    7: 'i386',
    12: 'arm',
    18: 'ppc',
    0x01000007: 'x86_64',
    0x0100000c: 'arm64',
    0x01000012: 'ppc64',
  }[cputype] ?? `cpu-${cputype}`;
}

function readCpuType(buf: Buffer, offset: number, littleEndian: boolean): number | undefined {
  if (offset + 4 > buf.length) return undefined;
  return littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function detectArchitectures(buf: Buffer): string[] {
  if (buf.length < 4) return [];
  const magic = buf.readUInt32BE(0);
  const architectures: string[] = [];
  const add = (cputype: number | undefined): void => {
    if (cputype === undefined) return;
    const name = architectureName(cputype);
    if (!architectures.includes(name)) architectures.push(name);
  };

  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    const littleEndian = magic === 0xbebafeca;
    const count = readCpuType(buf, 4, littleEndian);
    if (count === undefined) return [];
    for (let index = 0; index < count; index += 1) add(readCpuType(buf, 8 + index * 20, littleEndian));
    return architectures;
  }

  const littleEndian = magic === 0xcefaedfe || magic === 0xcffaedfe;
  if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) add(readCpuType(buf, 4, littleEndian));
  return architectures;
}

function extractEntitlementKeys(profile: Buffer | undefined): string[] {
  if (!profile) return [];
  const text = profile.toString('utf8');
  const start = text.indexOf('<plist');
  const end = text.indexOf('</plist>');
  if (start === -1 || end === -1) return [];
  try {
    const parsed = parseXmlPlist(text.slice(start, end + '</plist>'.length)) as { Entitlements?: unknown };
    if (!parsed.Entitlements || typeof parsed.Entitlements !== 'object') return [];
    return Object.keys(parsed.Entitlements as Record<string, unknown>).sort();
  } catch {
    return [];
  }
}

function archiveFrameworkNames(names: string[]): string[] {
  const frameworks = new Set<string>();
  for (const name of names) {
    const match = /^Payload\/[^/]+\.app\/Frameworks\/([^/]+?)(?:\.framework\/|\.dylib$)/.exec(name);
    if (match) frameworks.add(match[1]);
  }
  return [...frameworks].sort();
}

export async function extractIpaMetadata(ipaPath: string): Promise<ExtractedIpaMetadata> {
  const zip = new AdmZip(ipaPath);
  const entries = zip.getEntries();
  const entry = entries.find((e) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(e.entryName));
  if (!entry) throw new Error('Info.plist not found in Payload/*.app');

  const raw = parsePlistBuffer(entry.getData());
  const infoPlist = sanitizeInfoPlist(raw);
  const appPrefix = /^Payload\/([^/]+\.app)\/Info\.plist$/.exec(entry.entryName)?.[1];
  const executableEntry = raw.CFBundleExecutable && appPrefix
    ? entries.find((candidate) => candidate.entryName === `Payload/${appPrefix}/${String(raw.CFBundleExecutable)}`)
    : undefined;
  const profileEntry = appPrefix ? entries.find((candidate) => candidate.entryName === `Payload/${appPrefix}/embedded.mobileprovision`) : undefined;
  const files = entries.filter((candidate) => !candidate.isDirectory);

  return {
    summary: {
      bundleVersion: typeof raw.CFBundleVersion === 'string' ? raw.CFBundleVersion : undefined,
      shortVersion: typeof raw.CFBundleShortVersionString === 'string' ? raw.CFBundleShortVersionString : undefined,
      minOsVersion: typeof raw.MinimumOSVersion === 'string' ? raw.MinimumOSVersion : undefined,
      executable: typeof raw.CFBundleExecutable === 'string' ? raw.CFBundleExecutable : undefined,
      architectures: executableEntry ? detectArchitectures(executableEntry.getData()) : [],
      entitlementKeys: extractEntitlementKeys(profileEntry?.getData()),
      embeddedFrameworks: archiveFrameworkNames(files.map((candidate) => candidate.entryName)),
      fileCount: files.length,
      compressedSizeBytes: files.reduce((sum, candidate) => sum + (candidate.header.compressedSize ?? 0), 0),
      uncompressedSizeBytes: files.reduce((sum, candidate) => sum + (candidate.header.size ?? 0), 0),
      codeSignaturePresent: files.some((candidate) => /^Payload\/[^/]+\.app\/_CodeSignature\/CodeResources$/.test(candidate.entryName)),
    },
    infoPlist,
  };
}
