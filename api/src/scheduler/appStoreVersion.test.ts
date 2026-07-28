import { expect, test } from 'bun:test';
import { resolveAppStoreDecryptTarget, selectAppStoreVersion } from './appStoreVersion.js';

test('selects the version matching the App Store lookup instead of stale latest metadata', () => {
  const version = selectAppStoreVersion(
    [
      { externalVersionId: '888139588', isLatest: true, displayVersion: '337.0' },
      { externalVersionId: '888477548', isLatest: false, displayVersion: '338.0' },
    ],
    '338.0',
  );

  expect(version?.externalVersionId).toBe('888477548');
});

test('keeps the current App Store release schedulable while its external version id is unavailable', () => {
  expect(resolveAppStoreDecryptTarget([], '339.0')).toEqual({ expectedVersion: '339.0' });
});
