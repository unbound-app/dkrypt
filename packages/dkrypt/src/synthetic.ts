import { getDeviceHealth } from '#deviceHealth.js';
import { getRustDeviceBridgeStatus } from '#idevice.js';
import { incrementMetric, observeMetric, setGaugeMetric } from '#metrics.js';
import { getEffectiveDevices, getStateDatabaseStatus } from '#store/state.js';
import { getDiskUsage } from '#util/diskUsage.js';
import { config, cryptoBillingEnabled, stripeEnabled } from '#config.js';
import { getTestFlightCatalogCacheState } from '#testflightSubscriptions.js';
import { listWebhookInbox } from '#webhookInbox.js';
import { getNowPaymentsProviderStatus } from '#nowpayments.js';
import { getStripeWebhookHealth } from '#stripeWebhookHealth.js';

export interface SyntheticProbeResult {
  id: 'database' | 'artifacts' | 'device-bridge' | 'device-agent' | 'testflight' | 'webhooks';
  status: 'ok' | 'warn' | 'error' | 'skipped';
  durationMs: number;
  detail: string;
}

export function classifyTestFlightCatalogProbe(cache: ReturnType<typeof getTestFlightCatalogCacheState>): Pick<SyntheticProbeResult, 'status' | 'detail'> {
  if (cache.stale) {
    return {
      status: 'warn',
      detail: cache.fetchedAt
        ? 'The last device verification is stale; this read-only probe did not refresh it'
        : 'No on-device verification is cached; this read-only probe did not launch TestFlight',
    };
  }
  return { status: 'ok', detail: `${cache.apps.length} app(s) recently verified on device` };
}

export function classifyWebhookProbe(
  providers: Array<{ name: string; status: 'ready' | 'misconfigured' | 'unavailable'; detail?: string }>,
  inboxFailures: number,
): Pick<SyntheticProbeResult, 'status' | 'detail'> {
  if (providers.length === 0) return { status: 'skipped', detail: 'No billing webhook provider is configured' };

  const configurationIssues = providers
    .filter((provider) => provider.status === 'misconfigured')
    .map((provider) => provider.detail ?? `${provider.name} webhook configuration needs attention`);
  if (configurationIssues.length > 0) return { status: 'error', detail: configurationIssues.join('; ') };

  const warnings = providers
    .filter((provider) => provider.status === 'unavailable')
    .map((provider) => provider.detail ?? `${provider.name} is temporarily unavailable`);
  if (inboxFailures > 0) warnings.push(`${inboxFailures} billing webhook event(s) need attention`);
  if (warnings.length > 0) return { status: 'warn', detail: warnings.join('; ') };

  return { status: 'ok', detail: `${providers.map((provider) => provider.name).join(' and ')} webhook readiness verified` };
}

export async function runSyntheticProbe<T extends SyntheticProbeResult['id']>(id: T, action: () => Promise<Omit<SyntheticProbeResult, 'id' | 'durationMs'>>): Promise<SyntheticProbeResult> {
  const startedAt = performance.now();
  try {
    const result = await action();
    const durationMs = Math.round(performance.now() - startedAt);
    if (result.status === 'error') incrementMetric('synthetic_probe_failures_total', { probe: id });
    observeMetric('synthetic_probe_duration_ms', durationMs, { probe: id, outcome: result.status });
    return { id, durationMs, ...result };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    incrementMetric('synthetic_probe_failures_total', { probe: id });
    observeMetric('synthetic_probe_duration_ms', durationMs, { probe: id, outcome: 'error' });
    return { id, durationMs, status: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runSyntheticProbes(): Promise<{ ok: boolean; checkedAt: string; probes: SyntheticProbeResult[] }> {
  const probes = await Promise.all([
    runSyntheticProbe('database', async () => {
      const status = getStateDatabaseStatus();
      return status.integrity === 'ok'
        ? { status: 'ok' as const, detail: `SQLite schema ${status.schemaVersion} is intact` }
        : { status: 'error' as const, detail: 'SQLite integrity check failed' };
    }),
    runSyntheticProbe('artifacts', async () => {
      const usage = getDiskUsage(config.artifactDir);
      if (!usage) {
        setGaugeMetric('artifact_storage_available', 0);
        return { status: 'error' as const, detail: 'Artifact storage is unavailable' };
      }
      setGaugeMetric('artifact_storage_available', 1);
      setGaugeMetric('artifact_storage_used_percent', usage.usedPercent * 100);
      setGaugeMetric('artifact_storage_free_bytes', usage.freeBytes);
      if (usage.usedPercent >= 0.95) return { status: 'error' as const, detail: `${Math.round(usage.usedPercent * 100)}% of artifact storage is used` };
      if (usage.usedPercent >= 0.85) return { status: 'warn' as const, detail: `${Math.round(usage.usedPercent * 100)}% of artifact storage is used` };
      return { status: 'ok' as const, detail: `${Math.round(usage.usedPercent * 100)}% of artifact storage is used` };
    }),
    runSyntheticProbe('device-bridge', async () => {
      const status = await getRustDeviceBridgeStatus();
      return {
        status: status.state === 'ready' ? 'ok' as const : 'warn' as const,
        detail: `Rust bridge is ${status.state} with ${status.deviceCount} discovered device(s)`,
      };
    }),
    runSyntheticProbe('device-agent', async () => {
      const devices = getEffectiveDevices().filter((device) => device.enabled);
      if (devices.length === 0) return { status: 'skipped' as const, detail: 'No enabled device is configured' };
      const primary = devices.find((device) => device.isPrimary) ?? devices[0];
      const health = await getDeviceHealth(primary.id, true);
      if (!health.reachable) return { status: 'error' as const, detail: health.error ?? 'Configured device is unreachable' };
      if (health.subsystems?.agent === 'offline') return { status: 'warn' as const, detail: 'USB transport is ready but the device agent is unavailable' };
      return { status: 'ok' as const, detail: 'Configured device agent responded' };
    }),
    runSyntheticProbe('testflight', async () => {
      const devices = getEffectiveDevices().filter((device) => device.enabled);
      if (devices.length === 0) return { status: 'skipped' as const, detail: 'No enabled device is configured' };
      return classifyTestFlightCatalogProbe(getTestFlightCatalogCacheState());
    }),
    runSyntheticProbe('webhooks', async () => {
      const inbox = listWebhookInbox();
      const failures = inbox.filter((record) => record.status === 'failed' || record.status === 'quarantined').length;
      const [stripeHealth, nowPaymentsStatus] = await Promise.all([
        stripeEnabled ? getStripeWebhookHealth(undefined) : undefined,
        cryptoBillingEnabled ? getNowPaymentsProviderStatus() : undefined,
      ]);
      const providers: Array<{ name: string; status: 'ready' | 'misconfigured' | 'unavailable'; detail?: string }> = [];

      if (stripeHealth) {
        if (stripeHealth.state === 'ready') providers.push({ name: 'Stripe', status: 'ready' });
        else if (stripeHealth.state === 'missing_events') providers.push({
          name: 'Stripe',
          status: 'misconfigured',
          detail: `Stripe webhook endpoint is missing required events: ${stripeHealth.missingEvents.join(', ')}`,
        });
        else if (stripeHealth.state === 'missing_endpoint') providers.push({
          name: 'Stripe',
          status: 'misconfigured',
          detail: 'Stripe webhook endpoint is missing or disabled',
        });
        else if (stripeHealth.state === 'unavailable') providers.push({
          name: 'Stripe',
          status: 'unavailable',
          detail: 'Stripe webhook readiness could not be checked',
        });
        else providers.push({ name: 'Stripe', status: 'misconfigured', detail: 'Stripe webhook is not configured' });
      }

      if (nowPaymentsStatus) providers.push(nowPaymentsStatus.ready
        ? { name: 'NOWPayments', status: 'ready' }
        : {
            name: 'NOWPayments',
            status: 'misconfigured',
            detail: `NOWPayments webhook provider is not ready${nowPaymentsStatus.issues.length ? `: ${nowPaymentsStatus.issues.join(', ')}` : ''}`,
          });

      return classifyWebhookProbe(providers, failures);
    }),
  ]);
  return {
    ok: probes.every((probeResult) => probeResult.status !== 'error'),
    checkedAt: new Date().toISOString(),
    probes,
  };
}
