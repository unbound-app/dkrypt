import { describe, expect, test } from 'bun:test';
import { parsePastedDecryptInput, parsePastedDecryptInputs } from './pastedDecryptInputs';

describe('pasted decrypt inputs', () => {
  test('recognizes bundle IDs and Apple app links', () => {
    expect(parsePastedDecryptInput('com.example.app')).toMatchObject({ kind: 'bundle', bundleId: 'com.example.app' });
    expect(parsePastedDecryptInput('https://apps.apple.com/us/app/example/id123456789?at=abc')).toMatchObject({ kind: 'appstore', trackId: 123456789 });
  });

  test('canonicalizes public TestFlight invites without subscribing', () => {
    expect(parsePastedDecryptInput('https://testflight.apple.com/join/ABC123/')).toMatchObject({ kind: 'testflight', url: 'https://testflight.apple.com/join/ABC123' });
  });

  test('rejects impostor hosts and unsafe schemes', () => {
    for (const value of ['http://apps.apple.com/us/app/id123', 'https://apps.apple.com.evil.test/us/app/id123', 'https://testflight.apple.com.evil.test/join/ABC123', 'https://testflight.apple.com/join/ABC123?x=1']) {
      expect(parsePastedDecryptInput(value).kind).toBe('invalid');
    }
  });

  test('deduplicates and limits pasted rows', () => {
    const parsed = parsePastedDecryptInputs('com.example.app\ncom.example.app\nhttps://testflight.apple.com/join/A');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.duplicates).toHaveLength(1);
    expect(parsePastedDecryptInputs(Array.from({ length: 51 }, (_, index) => `com.example.app${index}`).join('\n')).overflow).toBe(true);
  });
});
