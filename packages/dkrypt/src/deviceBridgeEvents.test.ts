import { afterEach, describe, expect, it } from 'bun:test';
import { createOtlpMetricsPayload, resetMetrics } from '#metrics.js';
import { calculateRustDeviceEventRetry, RustDeviceEventMetricTracker, startRustDeviceEventMonitoring } from '#deviceBridgeEvents.js';

async function waitForAttempts(readAttempts: () => number, minimum: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && readAttempts() < minimum; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
}

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
      await waitForAttempts(() => attempts, 2);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      await stop();
    }
  });

  it('reconnects after an established native event stream drops', async () => {
    let attempts = 0;
    const stop = startRustDeviceEventMonitoring({
      subscriber: async (onEvent, onError) => {
        attempts += 1;
        onEvent({ type: 'device_snapshot', sequence: attempts, devices: [] });
        if (attempts === 1) queueMicrotask(() => onError?.(new Error('fixture stream closed')));
        return () => {};
      },
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
      stableConnectionMs: 1_000,
    });

    try {
      await waitForAttempts(() => attempts, 2);

      const metrics = createOtlpMetricsPayload('dkrypt').resourceMetrics[0].scopeMetrics[0].metrics;
      const streamFailures = metrics.find((metric) => metric.name === 'dkrypt_device_bridge_event_stream_failures_total')?.sum?.dataPoints;
      const connected = metrics.find((metric) => metric.name === 'dkrypt_device_bridge_event_stream_connected')?.gauge?.dataPoints;

      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(streamFailures?.[0].asInt).toBe('1');
      expect(connected?.[0].asDouble).toBe(1);
    } finally {
      await stop();
    }
  });

  it('refreshes health on USB connect and disconnect while ignoring startup snapshots and Wi-Fi changes', async () => {
    const refreshedDeviceIds: string[] = [];
    let attempts = 0;
    const stop = startRustDeviceEventMonitoring({
      onUsbDeviceHealthRefresh: (deviceId) => refreshedDeviceIds.push(deviceId),
      subscriber: async (onEvent) => {
        attempts += 1;
        const devices = [
          { id: 'usb-udid', transport: 'usb' },
          { id: 'wifi-udid', transport: 'wifi:192.0.2.5' },
        ];
        onEvent({ type: 'device_snapshot', sequence: 1, devices });
        onEvent({ type: 'device_connected', sequence: 2, devices });
        onEvent({ type: 'device_disconnected', sequence: 3, devices: [devices[1]] });
        onEvent({ type: 'device_connected', sequence: 4, devices });
        onEvent({ type: 'device_connected', sequence: 4, devices });
        return () => {};
      },
    });

    try {
      await waitForAttempts(() => attempts, 1);
      expect(refreshedDeviceIds).toEqual(['usb-udid', 'usb-udid']);
    } finally {
      await stop();
    }
  });

  it('refreshes old, unchanged, and newly present USB devices from a replacement snapshot', async () => {
    const refreshedDeviceIds: string[] = [];
    let attempts = 0;
    const stop = startRustDeviceEventMonitoring({
      onUsbDeviceHealthRefresh: (deviceId) => refreshedDeviceIds.push(deviceId),
      subscriber: async (onEvent, onError) => {
        attempts += 1;
        onEvent({
          type: 'device_snapshot',
          sequence: attempts,
          devices: attempts === 1 ? [
            { id: 'missing-udid', transport: 'usb' },
            { id: 'unchanged-udid', transport: 'usb' },
            { id: 'wifi-udid', transport: 'wifi:192.0.2.5' },
          ] : [
            { id: 'usb-udid', transport: 'usb' },
            { id: 'unchanged-udid', transport: 'usb' },
            { id: 'wifi-udid', transport: 'wifi:192.0.2.5' },
          ],
        });
        if (attempts === 1) queueMicrotask(() => onError?.(new Error('fixture stream closed')));
        return () => {};
      },
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });

    try {
      await waitForAttempts(() => refreshedDeviceIds.length, 1);
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(refreshedDeviceIds.sort()).toEqual(['missing-udid', 'unchanged-udid', 'usb-udid']);
    } finally {
      await stop();
    }
  });
});
