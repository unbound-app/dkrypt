import { describe, expect, test } from 'bun:test';
import { isFormattingLocalePreference, normalizeFormattingLocalePreference, resolveLocaleTag } from './locale';

describe('locale preferences', () => {
  test('accepts only system, English, and German preferences', () => {
    expect(isFormattingLocalePreference('system')).toBe(true);
    expect(isFormattingLocalePreference('en')).toBe(true);
    expect(isFormattingLocalePreference('de')).toBe(true);
    expect(isFormattingLocalePreference('fr')).toBe(false);
    expect(normalizeFormattingLocalePreference('de')).toBe('de');
    expect(normalizeFormattingLocalePreference('fr')).toBe('system');
  });

  test('resolves fixed preferences to stable locale tags', () => {
    expect(resolveLocaleTag('en', ['de-DE'])).toBe('en');
    expect(resolveLocaleTag('de', ['en-US'])).toBe('de-DE');
  });

  test('uses the first valid system locale and falls back safely', () => {
    expect(resolveLocaleTag('system', ['de-DE', 'en-US'])).toBe('de-DE');
    expect(resolveLocaleTag('system', ['invalid_locale', 'en-GB'])).toBe('en-GB');
    expect(resolveLocaleTag('system', [])).toBe('en');
  });
});
