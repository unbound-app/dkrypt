import { describe, expect, test } from 'bun:test';
import { formatArtifactFilename, validArtifactFilenameTemplate } from './artifactFilename.js';

const artifact = {
  bundleId: 'com.example.viewer',
  versionLabel: '2.4.1',
  buildNumber: '148',
  channel: 'testflight' as const,
};

describe('artifact filename templates', () => {
  test('formats supported tokens into a safe IPA filename', () => {
    expect(formatArtifactFilename('{app}-{version}-{build}-{source}', artifact)).toBe('com.example.viewer-2.4.1-148-TestFlight.ipa');
  });

  test('rejects unsupported tokens and path syntax', () => {
    expect(validArtifactFilenameTemplate('{app}-{secret}')).toBe(false);
    expect(validArtifactFilenameTemplate('../{app}')).toBe(false);
    expect(validArtifactFilenameTemplate('{app}/{version}')).toBe(false);
  });

  test('falls back when a template has no usable result', () => {
    expect(formatArtifactFilename('---', artifact)).toBe('com.example.viewer-2.4.1.ipa');
  });
});
