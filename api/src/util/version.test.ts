import { describe, expect, test } from 'bun:test';
import { compareVersions, normalizeVersion } from '#util/version.js';

describe('normalizeVersion', () => {
  test('strips a leading v', () => {
    expect(normalizeVersion('v334.0')).toBe('334.0');
  });

  test('leaves a version with no leading v untouched', () => {
    expect(normalizeVersion('334.0')).toBe('334.0');
  });

  test('trims whitespace', () => {
    expect(normalizeVersion('  v1.2.3  ')).toBe('1.2.3');
  });
});

describe('compareVersions', () => {
  test('treats equal versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  test('is agnostic to a leading v on either side', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  test('compares numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
  });

  test('treats a missing trailing segment as 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBe(1);
  });
});
