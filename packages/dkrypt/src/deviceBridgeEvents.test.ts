import { afterEach, describe, expect, it } from 'bun:test';
import { createOtlpMetricsPayload, resetMetrics } from '#metrics.js';
import { calculateRustDeviceEventRetry, RustDeviceEventMetricTracker, startRustDeviceEventMonitoring } from '#deviceBridgeEvents.js';

describe('Rust device bridge event metrics', () => {
  afterEach(() => resetMetrics());

  it('counts observed USB disconnects and reconnects once without exposing device identifiers', () => {
    const tracker = new RustDeviceEventMetricTracker();
    tracker.record({ type: 'device_snapshot', sequence: 1, devices: [{ id: 'private-udid', transport: 'usb' }, { id: 'wifi-udid', transport: 'wifi:192.0.2.5' }] });
    tracker.record({ type: 'device_disconnected', sequence: 2, devices: [{ id: 'wifi-udid', transport: 'wifi:192.0.2.5' }] });
    tracker.record({ type: 'device_disconnected', sequence: 2, devices: [{ id: 'wifi-udid', transport: 'wifi:192.0.2.5' }] });
    tracker.record({ type: 'device_connected', sequence: 3, devices: [{ id: 'private-udid', transport: 'usb' }, { id: 'wifi-udid', transport: 'wifi:192.0.2.5' }] });

    const metrics = createOtlpMetricsPayload('dkrypt').resourceMetrics[0].scopeMetrics[0].metrics;
    const disconnects = metrics.find((metric) => metric.name === 'dkrypt_device_usb_disconnects_total')?.sum?.dataPoints;
    const reconnects = metrics.find((metric) => metric.name === 'dkrypt_device_usb_reconnects_total')?.sum?.dataPoints;
    const serialized = JSON.stringify(metrics);

    expect(disconnects?.[0].asInt).toBe('1');
    expect(reconnects?.[0].asInt).toBe('1');
    expect(serialized).not.toContain('private-udid');
    expect(serialized).not.toContain('wifi-udid');
  });

  it('does not count the initial snapshot as a reconnect', () => {
    const tracker = new RustDeviceEventMetricTracker();
    tracker.record({ type: 'device_snapshot', sequence: 1, devices: [{ id: 'private-udid', transport: 'usb' }] });
    tracker.record({ type: 'device_snapshot', sequence: 2, devices: [{ id: 'private-udid', transport: 'usb' }] });

    const metrics = createOtlpMetricsPayload('dkrypt').resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics.find((metric) => metric.name === 'dkrypt_device_usb_reconnects_total')).toBeUndefined();
    expect(metrics.find((metric) => metric.name === 'dkrypt_device_usb_disconnects_total')).toBeUndefined();
  });

  it('backs off short-lived streams and resets after a stable connection', () => {
    expect(calculateRustDeviceEventRetry(0, undefined, 10_000, 30_000, 1000, 30_000)).toEqual({ failures: 1, delayMs: 1000 });
    expect(calculateRustDeviceEventRetry(1, 5_000, 10_000, 30_000, 1000, 30_000)).toEqual({ failures: 2, delayMs: 2000 });
    expect(calculateRustDeviceEventRetry(5, 5_000, 40_000, 30_000, 1000, 30_000)).toEqual({ failures: 1, delayMs: 1000 });
  });

  it('retries when the initial native event snapshot stalls and stops cleanly', async () => {
    let attempts = 0;
    const stop = startRustDeviceEventMonitoring({
      subscriber: async (_onEvent, _onError, signal) => {
        attempts += 1;
        return await new Promise<() => void>((_resolve, reject) => {
          const onAbort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('event subscription aborted'));
          if (signal?.aborted) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
      initialSnapshotTimeoutMs: 5,
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 2,
    });
    try {
      for (let attempt = 0; attempt < 100 && attempts < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      await stop();
    }
  });
});
