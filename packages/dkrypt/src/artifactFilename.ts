import type { ArtifactRecord } from './artifactTypes.js';

const tokens = ['app', 'version', 'build', 'source'] as const;

export function validArtifactFilenameTemplate(template: string): boolean {
  if (template.length < 1 || template.length > 120 || /[/\\\x00-\x1f\x7f]/.test(template)) return false;
  const literalsOnly = template.replace(/\{(app|version|build|source)\}/g, '');
  if (/[{}]/.test(literalsOnly) || !/^[A-Za-z0-9 ._-]*$/.test(literalsOnly)) return false;
  return tokens.some((token) => template.includes(`{${token}}`));
}

function safePart(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[_ .-]+|[_ .-]+$/g, '').slice(0, 80);
}

export function formatArtifactFilename(template: string | undefined, artifact: Pick<ArtifactRecord, 'bundleId' | 'versionLabel' | 'buildNumber' | 'channel'>): string {
  const fallback = `${safePart(artifact.bundleId) || 'dkrypt'}${artifact.versionLabel ? `-${safePart(artifact.versionLabel)}` : ''}.ipa`;
  if (!template || !validArtifactFilenameTemplate(template)) return fallback;
  const values = {
    app: safePart(artifact.bundleId),
    version: safePart(artifact.versionLabel),
    build: safePart(artifact.buildNumber),
    source: artifact.channel === 'testflight' ? 'TestFlight' : 'AppStore',
  };
  const stem = template.replace(/\{(app|version|build|source)\}/g, (_, token: keyof typeof values) => values[token]).replace(/\s+/g, ' ').replace(/^[_ .-]+|[_ .-]+$/g, '').slice(0, 180);
  return stem ? `${stem}.ipa` : fallback;
}
