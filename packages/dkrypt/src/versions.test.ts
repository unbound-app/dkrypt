import { expect, test } from 'bun:test';
import { buildAppVersionEntries } from './versions.js';

test('latest App Store entry comes from current metadata when history has not observed it', () => {
  const entries = buildAppVersionEntries(
    '342.0',
    new Map([['889467057', { displayVersion: '341.0', releaseDate: '2026-08-12T01:37:23Z' }]]),
  );

  expect(entries[0]).toMatchObject({ isLatest: true, displayVersion: '342.0' });
  expect(entries[0]?.externalVersionId).toBeUndefined();
  expect(entries[1]).toMatchObject({ isLatest: false, displayVersion: '341.0', externalVersionId: '889467057' });
});
