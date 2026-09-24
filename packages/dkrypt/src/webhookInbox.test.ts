import { expect, test } from 'bun:test';
import { claimWebhook, markWebhookFailed, markWebhookProcessed, receiveWebhook, releaseWebhookClaim } from '#webhookInbox.js';

test('webhook inbox claims concurrent deliveries and permits retry after failure', () => {
  const eventId = `test:${crypto.randomUUID()}`;
  const first = receiveWebhook('stripe', eventId, '{"id":"evt_test"}');
  const duplicate = receiveWebhook('stripe', eventId, '{"id":"evt_test"}');

  expect(first.duplicate).toBe(false);
  expect(duplicate.duplicate).toBe(true);
  expect(claimWebhook(first.record.id)).toBe(true);
  expect(claimWebhook(duplicate.record.id)).toBe(false);

  markWebhookFailed(first.record.id, 'temporary failure');
  releaseWebhookClaim(first.record.id);

  expect(claimWebhook(first.record.id)).toBe(true);
  markWebhookProcessed(first.record.id);
  releaseWebhookClaim(first.record.id);
  expect(claimWebhook(first.record.id)).toBe(false);
});
