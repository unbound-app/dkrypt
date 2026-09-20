import { describe, expect, test } from 'bun:test';
import { formatSearchResultMeta, shouldShowSearchResultStatus } from './searchResultPresentation';

describe('search result presentation', () => {
  test('uses source copy instead of a fake version for TestFlight results', () => {
    expect(formatSearchResultMeta({ bundleId: 'com.example.app', version: 'TestFlight', sellerName: 'Example', category: 'Games', testflight: {} })).toBe('Available via TestFlight · Example · Games');
  });

  test('does not show bundle status for TestFlight results', () => {
    const statusByBundle = new Map([['com.example.app', 'done']]);
    expect(shouldShowSearchResultStatus({ bundleId: 'com.example.app', testflight: {} }, statusByBundle)).toBe(false);
    expect(shouldShowSearchResultStatus({ bundleId: 'com.example.app' }, statusByBundle)).toBe(true);
  });
});
