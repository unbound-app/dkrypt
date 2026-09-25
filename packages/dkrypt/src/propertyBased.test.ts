import AdmZip from 'adm-zip';
import { expect, test } from 'bun:test';
import fc from 'fast-check';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { build as buildPlist } from 'plist';
import { tmpdir } from 'node:os';
import { createBridgeEnvelope, createDeviceAgentEnvelope } from '#idevice.js';
import { BRIDGE_PROTOCOL_VERSION } from '#bridgeProtocol.js';
import { openStateDatabase, verifyDatabaseBackup } from '#store/sqlite.js';
import { normalizeTestFlightInvite } from '#testflightSubscriptions.js';
import { extractIpaMetadata } from '#util/ipaMetadata.js';
import { compareVersions, normalizeVersion } from '#util/version.js';

const versionPartsArbitrary = fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 6 });
const versionArbitrary = versionPartsArbitrary.map((parts) => parts.join('.'));
const inviteCharacters = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'];
const inviteCodeArbitrary = fc.array(fc.constantFrom(...inviteCharacters), { minLength: 4, maxLength: 32 }).map((characters) => characters.join(''));
const cpuTypeNames = new Map<number, string>([
  [7, 'i386'],
  [12, 'arm'],
  [18, 'ppc'],
  [0x01000007, 'x86_64'],
  [0x0100000c, 'arm64'],
  [0x01000012, 'ppc64'],
  [0x0100000d, 'cpu-16777229'],
]);

function compareNumericParts(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index] ?? 0;
    const rightPart = right[index] ?? 0;
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function bridgeSignature(secret: string, channel: string, requestId: string, issuedAt: number, payload: string): string {
  return createHmac('sha256', secret)
    .update(`${BRIDGE_PROTOCOL_VERSION}|${channel}|${requestId}|${issuedAt}|${payload}`)
    .digest('hex');
}

function deviceAgentSignature(secret: string, requestId: string, issuedAt: number, payload: string): string {
  return createHmac('sha256', secret)
    .update(`dkrypt-autoinstall-agent-v1|${requestId}|${issuedAt}|${payload}`)
    .digest('hex');
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('version parsing agrees with numeric tuple ordering for generated releases', () => {
  fc.assert(fc.property(versionPartsArbitrary, versionPartsArbitrary, (leftParts, rightParts) => {
    const left = leftParts.join('.');
    const right = rightParts.join('.');
    const expected = compareNumericParts(leftParts, rightParts);
    expect(compareVersions(left, right)).toBe(expected);
    expect(compareVersions(`v${left}`, right)).toBe(expected);
    expect(compareVersions(left, `v${right}`)).toBe(expected);
    expect(compareVersions(left, right)).toBe(-compareVersions(right, left));
  }), { numRuns: 500, seed: 20260925 });

  fc.assert(fc.property(versionArbitrary, (version) => {
    expect(normalizeVersion(`  v${version}  `)).toBe(version);
    expect(compareVersions(version, `${version}.0`)).toBe(0);
  }), { numRuns: 250, seed: 20260926 });
});

test('TestFlight invite normalization is idempotent for generated public invite codes', () => {
  fc.assert(fc.property(inviteCodeArbitrary, fc.string({ maxLength: 32 }), (inviteCode, query) => {
    const input = ` https://testflight.apple.com/join/${inviteCode}?state=${encodeURIComponent(query)}#invite `;
    const normalized = normalizeTestFlightInvite(input);
    expect(normalized).toEqual({ url: `https://testflight.apple.com/join/${inviteCode}`, inviteCode });
    expect(normalizeTestFlightInvite(normalized.url)).toEqual(normalized);
  }), { numRuns: 350, seed: 20260927 });

  fc.assert(fc.property(inviteCodeArbitrary, (inviteCode) => {
    expect(() => normalizeTestFlightInvite(`https://testflight.apple.com.evil.invalid/join/${inviteCode}`)).toThrow();
    expect(() => normalizeTestFlightInvite(`https://evil.testflight.apple.com/join/${inviteCode}`)).toThrow();
  }), { numRuns: 150, seed: 20260928 });
});

test('SQLite schema migration and backup restore preserve generated state', async () => {
  const stateArbitrary = fc.record({
    version: fc.constant(16),
    devices: fc.uniqueArray(
      fc.record({ id: fc.uuid(), name: fc.string({ maxLength: 32 }), enabled: fc.boolean(), updatedAt: fc.nat({ max: 2_000_000_000_000 }) }),
      { selector: (device) => device.id, maxLength: 8 },
    ),
    settings: fc.record({ maintenanceMode: fc.boolean(), jobHistoryRetentionDays: fc.integer({ min: 0, max: 365 }), opaqueValue: fc.jsonValue({ maxDepth: 3 }) }),
  });
  const legacyJobsArbitrary = fc.uniqueArray(
    fc.record({ id: fc.uuid(), bundleId: fc.string({ maxLength: 32 }), status: fc.constantFrom('queued', 'running', 'done', 'failed') }),
    { selector: (job) => job.id, maxLength: 8 },
  );
  const legacyArtifactsArbitrary = fc.uniqueArray(
    fc.record({ id: fc.uuid(), bundleId: fc.string({ maxLength: 32 }), sizeBytes: fc.nat({ max: 2_000_000_000 }) }),
    { selector: (artifact) => artifact.id, maxLength: 8 },
  );

  await fc.assert(fc.asyncProperty(stateArbitrary, legacyJobsArbitrary, legacyArtifactsArbitrary, async (generatedState, legacyJobs, legacyArtifacts) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-property-sqlite-'));
    const backupPath = path.join(stateDir, 'restore.sqlite');
    let database: ReturnType<typeof openStateDatabase> | undefined;
    try {
      const expected = jsonRoundTrip(generatedState);
      database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      database.writeState(generatedState);
      expect(database.readState()).toEqual(expected);
      database.replaceCollection('jobs', legacyJobs.map((job, index) => ({ id: job.id, payload: job, updatedAt: index + 1 })));
      database.replaceCollection('artifacts', legacyArtifacts.map((artifact, index) => ({ id: artifact.id, payload: artifact, updatedAt: index + 1 })));
      database.db.query('DELETE FROM schema_migrations WHERE version = 6').run();
      database.close();
      database = undefined;
      database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
      expect(database.schemaVersion).toBe(6);
      expect(database.integrityStatus()).toBe('ok');
      expect(database.readState()).toEqual(expected);
      expect((database.readCollection('jobs') as Array<{ id: string; projectId: string }>).map((job) => [job.id, job.projectId]).sort()).toEqual(legacyJobs.map((job) => [job.id, 'default']).sort());
      expect((database.readCollection('artifacts') as Array<{ id: string; projectIds: string[] }>).map((artifact) => [artifact.id, artifact.projectIds]).sort()).toEqual(legacyArtifacts.map((artifact) => [artifact.id, ['default']]).sort());
      database.backupTo(backupPath);
      expect(verifyDatabaseBackup(backupPath)).toEqual({ schemaVersion: 6, integrity: 'ok', hasStateSnapshot: true });
      database.close();
      database = undefined;
      database = openStateDatabase({ stateDir, filename: 'restore.sqlite' });
      expect(database.integrityStatus()).toBe('ok');
      expect(database.readState()).toEqual(expected);
    } finally {
      database?.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }), { numRuns: 24, seed: 20260929 });
});

test('IPA metadata extraction preserves generated versions and Mach-O architectures', async () => {
  const cpuTypes = [...cpuTypeNames.keys()];
  const cpuTypeArbitrary = fc.constantFrom(...cpuTypes);

  await fc.assert(fc.asyncProperty(versionArbitrary, versionArbitrary, cpuTypeArbitrary, async (bundleVersion, shortVersion, cpuType) => {
    const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-property-ipa-'));
    const ipaPath = path.join(stateDir, 'generated.ipa');
    try {
      const plist = buildPlist({
        CFBundleVersion: bundleVersion,
        CFBundleShortVersionString: shortVersion,
        CFBundleExecutable: 'Generated',
        NestedValue: { ignored: true },
      });
      const executable = Buffer.alloc(12);
      executable.writeUInt32BE(0xfeedfacf, 0);
      executable.writeUInt32BE(cpuType, 4);
      const archive = new AdmZip();
      archive.addFile('Payload/Generated.app/Info.plist', Buffer.from(plist));
      archive.addFile('Payload/Generated.app/Generated', executable);
      archive.writeZip(ipaPath);

      const result = await extractIpaMetadata(ipaPath);
      expect(result.summary).toMatchObject({ bundleVersion, shortVersion, executable: 'Generated', architectures: [cpuTypeNames.get(cpuType)] });
      expect(result.infoPlist).toEqual({ CFBundleVersion: bundleVersion, CFBundleShortVersionString: shortVersion, CFBundleExecutable: 'Generated' });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }), { numRuns: 36, seed: 20260930 });
});

test('authenticated bridge envelopes bind generated payloads to their channel and request', () => {
  const channelArbitrary = fc.constantFrom('springboard' as const, 'testflight' as const, 'appstore' as const);
  const requestArbitrary = fc.record({ action: fc.string({ maxLength: 32 }), payload: fc.jsonValue({ maxDepth: 3 }), enabled: fc.boolean() });
  const secretArbitrary = fc.string({ minLength: 1, maxLength: 64 });

  fc.assert(fc.property(secretArbitrary, channelArbitrary, requestArbitrary, fc.uuid(), fc.integer({ min: 1, max: 2_000_000_000 }), (secret, channel, request, requestId, issuedAt) => {
    const envelope = createBridgeEnvelope(secret, channel, request, requestId, issuedAt);
    expect(JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'))).toEqual(jsonRoundTrip(request));
    expect(envelope.signature).toBe(bridgeSignature(secret, channel, requestId, issuedAt, envelope.payload));
    expect(envelope.signature).not.toBe(bridgeSignature(secret, channel === 'appstore' ? 'testflight' : 'appstore', requestId, issuedAt, envelope.payload));
    expect(envelope.signature).not.toBe(bridgeSignature(secret, channel, `${requestId}x`, issuedAt, envelope.payload));
  }), { numRuns: 400, seed: 20261001 });

  fc.assert(fc.property(secretArbitrary, requestArbitrary, fc.uuid(), fc.integer({ min: 1, max: 2_000_000_000 }), (secret, request, requestId, issuedAt) => {
    const envelope = createDeviceAgentEnvelope(secret, requestId, request, issuedAt);
    expect(JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'))).toEqual(jsonRoundTrip(request));
    expect(envelope.signature).toBe(deviceAgentSignature(secret, requestId, issuedAt, envelope.payload));
    expect(envelope.signature).not.toBe(deviceAgentSignature(secret, `${requestId}x`, issuedAt, envelope.payload));
  }), { numRuns: 400, seed: 20261002 });
});
