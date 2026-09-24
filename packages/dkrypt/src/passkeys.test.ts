import { expect, test } from 'bun:test';
import { beginPasskeyAuthentication, clearPasskeyChallenges } from '#passkeys.js';

test('passkey authentication options use a discoverable credential flow', async () => {
  const options = await beginPasskeyAuthentication();
  expect(typeof options.challenge).toBe('string');
  expect(typeof options.rpId).toBe('string');
  clearPasskeyChallenges();
});
