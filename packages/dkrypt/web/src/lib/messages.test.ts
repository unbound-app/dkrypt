import { expect, test } from 'bun:test';
import { translateMessage, translatePermissionLabel } from './messages';

test('provides localized messages for the dashboard shell', () => {
  expect(translateMessage('nav.home', 'en')).toBe('Home');
  expect(translateMessage('nav.home', 'de')).toBe('Startseite');
  expect(translateMessage('nav.settings', 'de')).toBe('Einstellungen');
  expect(translateMessage('appearance.interfaceLanguage', 'de')).toBe('Anzeigesprache');
  expect(translateMessage('appearance.accentBlue', 'de')).toBe('Blau');
  expect(translateMessage('appearance.accentGreen', 'de')).toBe('Grün');
  expect(translateMessage('appearance.highContrastMode', 'en')).toBe('High contrast mode');
  expect(translateMessage('appearance.darkPreference', 'de')).toBe('dunkel');
  expect(translateMessage('account.loginConnections', 'de')).toBe('Anmeldeverbindungen');
  expect(translateMessage('notifications.successfulDecrypts', 'de')).toBe('Erfolgreiche Entschlüsselungen');
  expect(translateMessage('account.manageSessions', 'de')).toBe('Sitzungen verwalten');
  expect(translateMessage('appearance.english', 'de')).toBe('Englisch');
  expect(translatePermissionLabel('administrator', 'de')).toBe('Administrator');
  expect(translatePermissionLabel('requestDecrypt', 'de')).toBe('Eigene Entschlüsselungsaufträge beantragen und verwalten');
});
