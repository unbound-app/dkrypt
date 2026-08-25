import { describe, expect, test } from 'bun:test';
import { normalizeVersionSelector, VERSION_SELECTOR_RE } from './decryptTarget.js';

describe('decrypt version selectors', () => {
  test('accepts stable and TestFlight tag shapes', () => {
    for (const selector of ['240', '234.2', 'v240', '240_109440', 'v234.2_109440']) {
      expect(VERSION_SELECTOR_RE.test(selector)).toBe(true);
      expect(normalizeVersionSelector(selector)).toBe(selector.replace(/^v/i, ''));
    }
  });

  test('rejects non-tag input and treats blank as latest', () => {
    expect(normalizeVersionSelector('')).toBeUndefined();
    expect(normalizeVersionSelector(undefined)).toBeUndefined();
    for (const selector of ['latest', '240-beta', '240_']) {
      expect(() => normalizeVersionSelector(selector)).toThrow(/version/);
    }
    expect(() => normalizeVersionSelector('release-240')).toThrow(/version/);
  });
});
