import { afterEach, describe, expect, it } from 'bun:test';
import { createOtlpMetricsPayload, resetMetrics } from '#metrics.js';
import { RustDeviceEventMetricTracker } from '#deviceBridgeEvents.js';

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
    const reconnects = metrics.find((metric) => metric.name === 'dkrypt_device_reconnects_total')?.sum?.dataPoints;
    const usbReconnect = reconnects?.find((point) => point.attributes.some((attribute) => attribute.key === 'source' && 'stringValue' in attribute.value && attribute.value.stringValue === 'usbmux_event'));
    const serialized = JSON.stringify(metrics);

    expect(disconnects?.[0].asInt).toBe('1');
    expect(usbReconnect?.asInt).toBe('1');
    expect(serialized).not.toContain('private-udid');
    expect(serialized).not.toContain('wifi-udid');
  });

  it('does not count the initial snapshot as a reconnect', () => {
    const tracker = new RustDeviceEventMetricTracker();
    tracker.record({ type: 'device_snapshot', sequence: 1, devices: [{ id: 'private-udid', transport: 'usb' }] });
    tracker.record({ type: 'device_snapshot', sequence: 2, devices: [{ id: 'private-udid', transport: 'usb' }] });

    const metrics = createOtlpMetricsPayload('dkrypt').resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics.find((metric) => metric.name === 'dkrypt_device_reconnects_total')).toBeUndefined();
    expect(metrics.find((metric) => metric.name === 'dkrypt_device_usb_disconnects_total')).toBeUndefined();
  });
});
