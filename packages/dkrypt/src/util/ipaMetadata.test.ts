import AdmZip from 'adm-zip';
import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractIpaMetadata } from '#util/ipaMetadata.js';

test('extracts archive inspection metadata from an IPA', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-ipa-metadata-'));
  const outputPath = path.join(root, 'sample.ipa');
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>42</string><key>CFBundleShortVersionString</key><string>1.2.3</string><key>MinimumOSVersion</key><string>15.0</string><key>CFBundleExecutable</key><string>Sample</string></dict></plist>`;
  const profile = `<plist version="1.0"><dict><key>Entitlements</key><dict><key>application-identifier</key><string>TEAM.com.example.sample</string><key>get-task-allow</key><false/></dict></dict></plist>`;
  const executable = Buffer.alloc(12);
  executable.writeUInt32BE(0xfeedfacf, 0);
  executable.writeUInt32BE(0x0100000c, 4);
  const zip = new AdmZip();
  zip.addFile('Payload/Sample.app/Info.plist', Buffer.from(infoPlist));
  zip.addFile('Payload/Sample.app/Sample', executable);
  zip.addFile('Payload/Sample.app/embedded.mobileprovision', Buffer.from(profile));
  zip.addFile('Payload/Sample.app/_CodeSignature/CodeResources', Buffer.from('{}'));
  zip.addFile('Payload/Sample.app/Frameworks/Example.framework/Example', Buffer.from('framework'));
  zip.writeZip(outputPath);

  const result = await extractIpaMetadata(outputPath);

  expect(result.summary).toMatchObject({
    shortVersion: '1.2.3',
    bundleVersion: '42',
    minOsVersion: '15.0',
    executable: 'Sample',
    architectures: ['arm64'],
    entitlementKeys: ['application-identifier', 'get-task-allow'],
    embeddedFrameworks: ['Example'],
    codeSignaturePresent: true,
  });
  expect(result.summary.fileCount).toBe(5);
  expect(result.summary.compressedSizeBytes).toBeGreaterThan(0);
  expect(result.summary.uncompressedSizeBytes).toBeGreaterThan(result.summary.compressedSizeBytes ?? 0);
});
