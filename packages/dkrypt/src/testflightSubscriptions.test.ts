import { describe, expect, test } from 'bun:test';
import { normalizeTestFlightInvite, parseTestFlightInviteHtml } from '#testflightSubscriptions.js';

describe('TestFlight public links', () => {
  test('normalizes canonical links and removes query state', () => {
    expect(normalizeTestFlightInvite(' https://testflight.apple.com/join/AbC123/?source=share#invite ')).toEqual({
      url: 'https://testflight.apple.com/join/AbC123',
      inviteCode: 'AbC123',
    });
  });

  test('rejects non-public or non-Apple links', () => {
    for (const value of [
      'http://testflight.apple.com/join/AbC123',
      'https://example.com/join/AbC123',
      'itms-beta://testflight.apple.com/join/AbC123',
      'https://testflight.apple.com/join/ab',
      'https://testflight.apple.com/apps/123',
    ]) {
      expect(() => normalizeTestFlightInvite(value)).toThrow();
    }
  });

  test('extracts app metadata from TestFlight invite HTML', () => {
    const parsed = parseTestFlightInviteHtml('<title>Join the Discord beta - TestFlight - Apple</title><meta property="og:image" content="https://example.com/icon.png">');
    expect(parsed).toEqual({ displayName: 'Discord', iconUrl: 'https://example.com/icon.png' });
  });
});
