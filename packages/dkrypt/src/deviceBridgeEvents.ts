import { scopedLogger } from '#logger.js';
import { incrementMetric, setGaugeMetric } from '#metrics.js';
import { subscribeRustDeviceBridgeEvents, type RustDeviceBridgeEvent } from '#idevice.js';
import { delayWithSignal } from '#util/abort.js';

const log = scopedLogger('idevice');

interface DeviceSummary {
  id?: unknown;
  udid?: unknown;
  transport?: unknown;
}

export class RustDeviceEventMetricTracker {
  private currentUsbDeviceIds?: Set<string>;
  private readonly seenUsbDeviceIds = new Set<string>();
  private lastSequence?: number;

  record(event: RustDeviceBridgeEvent): void {
    if (this.lastSequence === event.sequence) return;
    this.lastSequence = event.sequence;
    const current = new Set(event.devices.flatMap((device) => {
      if (!device || typeof device !== 'object') return [];
      const summary = device as DeviceSummary;
      const id = typeof summary.id === 'string' ? summary.id : typeof summary.udid === 'string' ? summary.udid : undefined;
      return id && summary.transport === 'usb' ? [id] : [];
    }));
    if (this.currentUsbDeviceIds) {
      for (const id of this.currentUsbDeviceIds) {
        if (!current.has(id)) incrementMetric('device_usb_disconnects_total', { source: 'usbmux_event' });
      }
      for (const id of current) {
        if (!this.currentUsbDeviceIds.has(id) && this.seenUsbDeviceIds.has(id)) {
          incrementMetric('device_reconnects_total', { transport: 'usb', source: 'usbmux_event' });
        }
      }
    }
    for (const id of current) this.seenUsbDeviceIds.add(id);
    this.currentUsbDeviceIds = current;
  }
}

function abortWait(signal: AbortSignal): { promise: Promise<void>; dispose(): void } {
  let removeListener = () => {};
  const promise = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    removeListener = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, dispose: removeListener };
}

async function monitorRustDeviceEvents(signal: AbortSignal): Promise<void> {
  const tracker = new RustDeviceEventMetricTracker();
  let failures = 0;
  setGaugeMetric('device_bridge_event_stream_connected', 0, { transport: 'usbmux' });
  while (!signal.aborted) {
    let stopStream: (() => void) | undefined;
    let resolveStreamFailure: (error: Error) => void = () => {};
    let receivedEvent = false;
    const streamFailure = new Promise<Error>((resolve) => {
      resolveStreamFailure = resolve;
    });
    const stopping = abortWait(signal);
    try {
      stopStream = await subscribeRustDeviceBridgeEvents(
        (event) => {
          receivedEvent = true;
          failures = 0;
          setGaugeMetric('device_bridge_event_stream_connected', 1, { transport: 'usbmux' });
          tracker.record(event);
        },
        resolveStreamFailure,
        signal,
      );
      if (signal.aborted) break;
      const terminal = await Promise.race([
        streamFailure.then((error) => ({ error })),
        stopping.promise.then(() => ({ error: undefined })),
      ]);
      if (!terminal.error) break;
      throw terminal.error;
    } catch (error) {
      if (signal.aborted) break;
      setGaugeMetric('device_bridge_event_stream_connected', 0, { transport: 'usbmux' });
      failures = Math.min(failures + 1, 6);
      incrementMetric('device_bridge_event_stream_failures_total');
      log.warn('Rust device bridge event stream unavailable; reconnecting', { error: error instanceof Error ? error.message : String(error) });
      const delayMs = receivedEvent ? 1000 : Math.min(1000 * 2 ** (failures - 1), 30_000);
      await delayWithSignal(delayMs, signal).catch(() => {});
    } finally {
      stopping.dispose();
      stopStream?.();
    }
  }
  setGaugeMetric('device_bridge_event_stream_connected', 0, { transport: 'usbmux' });
}

let activeMonitor: { controller: AbortController; task: Promise<void> } | undefined;

export function startRustDeviceEventMonitoring(): () => Promise<void> {
  if (activeMonitor) {
    const current = activeMonitor;
    return async () => {
      current.controller.abort();
      await current.task;
    };
  }
  const controller = new AbortController();
  const monitor = { controller, task: Promise.resolve() };
  monitor.task = monitorRustDeviceEvents(controller.signal).finally(() => {
    if (activeMonitor === monitor) activeMonitor = undefined;
  });
  activeMonitor = monitor;
  return async () => {
    controller.abort();
    await monitor.task;
  };
}
