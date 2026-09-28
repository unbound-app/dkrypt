import { expect, test } from 'bun:test';
import { translateMessage } from './messages';

test('provides localized messages for the dashboard shell', () => {
  expect(translateMessage('nav.home', 'en')).toBe('Home');
  expect(translateMessage('nav.home', 'de')).toBe('Startseite');
  expect(translateMessage('nav.settings', 'de')).toBe('Einstellungen');
  expect(translateMessage('appearance.interfaceLanguage', 'de')).toBe('Anzeigesprache');
  expect(translateMessage('appearance.accentBlue', 'de')).toBe('Blau');
  expect(translateMessage('appearance.accentGreen', 'de')).toBe('Grün');
});
