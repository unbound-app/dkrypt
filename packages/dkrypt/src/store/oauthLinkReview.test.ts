import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createPendingOauthLink, deletePendingOauthLink, getPendingOauthLink, pendingOauthLinkPreview } from '#store/oauthLinkReview.js';

test('OAuth link review is private, short-lived, and omits the other account identity', () => {
  const ownerId = randomUUID();
  const identity = { provider: 'github' as const, providerId: randomUUID(), username: 'external-account', displayName: 'External Account', source: 'oauth' as const, updatedAt: new Date().toISOString() };
  const pending = createPendingOauthLink(ownerId, identity);
  expect(getPendingOauthLink(pending.id, randomUUID())).toBeUndefined();
  expect(getPendingOauthLink(pending.id, ownerId)?.identity.providerId).toBe(identity.providerId);
  const preview = pendingOauthLinkPreview(pending);
  expect(preview.provider).toBe('github');
  expect(JSON.stringify(preview)).not.toContain(identity.username);
  deletePendingOauthLink(pending.id, ownerId);
  expect(getPendingOauthLink(pending.id, ownerId)).toBeUndefined();
});
