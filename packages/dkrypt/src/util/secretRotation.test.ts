import { describe, expect, test } from 'bun:test';
import { isValidCredentialRotation } from '#util/secretRotation.js';

describe('secret rotation validation', () => {
  test('requires distinct current and previous credentials meeting the minimum length', () => {
    expect(isValidCredentialRotation('current-credential', 'previous-credential', 16)).toBe(true);
    expect(isValidCredentialRotation('short', 'previous-credential', 16)).toBe(false);
    expect(isValidCredentialRotation('current-credential', 'short', 16)).toBe(false);
    expect(isValidCredentialRotation('same-credential', 'same-credential', 16)).toBe(false);
  });
});
