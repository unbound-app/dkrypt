import { expect, test } from 'bun:test';
import { renderMetrics, resetMetrics } from '#metrics.js';
import { claimWebhook, markWebhookFailed, markWebhookProcessed, receiveWebhook, releaseWebhookClaim } from '#webhookInbox.js';

test('webhook inbox claims concurrent deliveries and permits retry after failure', () => {
  resetMetrics();
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

  const metrics = renderMetrics();
  expect(metrics).toContain('dkrypt_webhook_events_received_total{provider="stripe"} 1');
  expect(metrics).toContain('dkrypt_webhook_events_duplicate_total{provider="stripe"} 1');
  expect(metrics).toContain('dkrypt_webhook_events_reconciled_total{provider="stripe"} 1');
  expect(metrics).toContain('dkrypt_webhook_reconciliation_failures_total{provider="stripe"} 1');
  resetMetrics();
});
