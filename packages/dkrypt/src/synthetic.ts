import { getDeviceHealth } from '#deviceHealth.js';
import { getRustDeviceBridgeStatus } from '#idevice.js';
import { observeMetric } from '#metrics.js';
import { getEffectiveDevices, getStateDatabaseStatus } from '#store/state.js';
import { getDiskUsage } from '#util/diskUsage.js';
import { config, cryptoBillingEnabled, stripeEnabled } from '#config.js';
import { getVerifiedTestFlightCatalog } from '#testflightSubscriptions.js';
import { listWebhookInbox } from '#webhookInbox.js';

export interface SyntheticProbeResult {
  id: 'database' | 'artifacts' | 'device-bridge' | 'device-agent' | 'testflight' | 'webhooks';
  status: 'ok' | 'warn' | 'error' | 'skipped';
  durationMs: number;
  detail: string;
}

async function probe<T extends SyntheticProbeResult['id']>(id: T, action: () => Promise<Omit<SyntheticProbeResult, 'id' | 'durationMs'>>): Promise<SyntheticProbeResult> {
  const startedAt = performance.now();
  try {
    const result = await action();
    const durationMs = Math.round(performance.now() - startedAt);
    observeMetric('synthetic_probe_duration_ms', durationMs);
    return { id, durationMs, ...result };
  } catch (error) {
    const durationMs = Math.round(performance.now() - startedAt);
    observeMetric('synthetic_probe_duration_ms', durationMs);
    return { id, durationMs, status: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function runSyntheticProbes(): Promise<{ ok: boolean; checkedAt: string; probes: SyntheticProbeResult[] }> {
  const probes = await Promise.all([
    probe('database', async () => {
      const status = getStateDatabaseStatus();
      return status.integrity === 'ok'
        ? { status: 'ok' as const, detail: `SQLite schema ${status.schemaVersion} is intact` }
        : { status: 'error' as const, detail: 'SQLite integrity check failed' };
    }),
    probe('artifacts', async () => {
      const usage = getDiskUsage(config.artifactDir);
      if (!usage) return { status: 'error' as const, detail: 'Artifact storage is unavailable' };
      if (usage.usedPercent >= 0.95) return { status: 'error' as const, detail: `${Math.round(usage.usedPercent * 100)}% of artifact storage is used` };
      if (usage.usedPercent >= 0.85) return { status: 'warn' as const, detail: `${Math.round(usage.usedPercent * 100)}% of artifact storage is used` };
      return { status: 'ok' as const, detail: `${Math.round(usage.usedPercent * 100)}% of artifact storage is used` };
    }),
    probe('device-bridge', async () => {
      const status = await getRustDeviceBridgeStatus();
      return {
        status: status.state === 'ready' ? 'ok' as const : 'warn' as const,
        detail: `Rust bridge is ${status.state} with ${status.deviceCount} discovered device(s)`,
      };
    }),
    probe('device-agent', async () => {
      const devices = getEffectiveDevices().filter((device) => device.enabled);
      if (devices.length === 0) return { status: 'skipped' as const, detail: 'No enabled device is configured' };
      const primary = devices.find((device) => device.isPrimary) ?? devices[0];
      const health = await getDeviceHealth(primary.id, true);
      if (!health.reachable) return { status: 'error' as const, detail: health.error ?? 'Configured device is unreachable' };
      if (health.subsystems?.agent === 'offline') return { status: 'warn' as const, detail: 'USB transport is ready but the device agent is unavailable' };
      return { status: 'ok' as const, detail: 'Configured device agent responded' };
    }),
    probe('testflight', async () => {
      const devices = getEffectiveDevices().filter((device) => device.enabled);
      if (devices.length === 0) return { status: 'skipped' as const, detail: 'No enabled device is configured' };
      const catalog = await getVerifiedTestFlightCatalog({ requireAllDevices: false });
      return { status: 'ok' as const, detail: `${catalog.length} TestFlight app(s) verified from the device` };
    }),
    probe('webhooks', async () => {
      const inbox = listWebhookInbox();
      const failures = inbox.filter((record) => record.status === 'failed' || record.status === 'quarantined').length;
      const providers = [stripeEnabled ? 'Stripe' : undefined, cryptoBillingEnabled ? 'NOWPayments' : undefined].filter(Boolean);
      if (providers.length === 0) return { status: 'skipped' as const, detail: 'No billing webhook provider is configured' };
      if (failures > 0) return { status: 'warn' as const, detail: `${failures} billing webhook event(s) need attention` };
      return { status: 'ok' as const, detail: `${providers.join(' and ')} webhook inbox is ready` };
    }),
  ]);
  return {
    ok: probes.every((probeResult) => probeResult.status !== 'error'),
    checkedAt: new Date().toISOString(),
    probes,
  };
}
