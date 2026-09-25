import { scopedLogger } from '#logger.js';
import { incrementMetric, setGaugeMetric } from '#metrics.js';
import { subscribeRustDeviceBridgeEvents, type RustDeviceBridgeEvent } from '#idevice.js';
import { abortedOperationError, delayWithSignal } from '#util/abort.js';

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
          incrementMetric('device_usb_reconnects_total', { source: 'usbmux_event' });
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

type DeviceEventSubscriber = typeof subscribeRustDeviceBridgeEvents;

export interface RustDeviceEventMonitoringOptions {
  subscriber?: DeviceEventSubscriber;
  initialSnapshotTimeoutMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  stableConnectionMs?: number;
}

export function calculateRustDeviceEventRetry(
  failures: number,
  firstEventAt: number | undefined,
  now: number,
  stableConnectionMs: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number,
): { failures: number; delayMs: number } {
  const stable = firstEventAt !== undefined && now - firstEventAt >= stableConnectionMs;
  const nextFailures = Math.min((stable ? 0 : failures) + 1, 30);
  return {
    failures: nextFailures,
    delayMs: Math.min(retryBaseDelayMs * 2 ** (nextFailures - 1), retryMaxDelayMs),
  };
}

function subscribeWithInitialSnapshotDeadline(
  subscriber: DeviceEventSubscriber,
  onEvent: (event: RustDeviceBridgeEvent) => void,
  onError: (error: Error) => void,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<() => void> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abortFromParent);
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      finish();
    };
    const abortFromParent = () => {
      const error = abortedOperationError(signal);
      controller.abort(error);
      settle(() => reject(error));
    };
    timer = setTimeout(() => {
      const error = new Error('Rust device bridge initial event snapshot timed out');
      controller.abort(error);
      settle(() => reject(error));
    }, Math.max(1, timeoutMs));
    timer.unref();
    if (signal.aborted) {
      abortFromParent();
      return;
    }
    signal.addEventListener('abort', abortFromParent, { once: true });
    let subscription: Promise<() => void>;
    try {
      subscription = Promise.resolve(subscriber(onEvent, onError, controller.signal));
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    void subscription.then((stop) => {
      if (settled || signal.aborted) {
        stop();
        return;
      }
      settle(() => resolve(stop));
    }, (error: unknown) => {
      settle(() => reject(error));
    });
  });
}

async function monitorRustDeviceEvents(signal: AbortSignal, options: RustDeviceEventMonitoringOptions): Promise<void> {
  const tracker = new RustDeviceEventMetricTracker();
  let failures = 0;
  const subscriber = options.subscriber ?? subscribeRustDeviceBridgeEvents;
  const retryBaseDelayMs = Math.max(1, options.retryBaseDelayMs ?? 1000);
  const retryMaxDelayMs = Math.max(retryBaseDelayMs, options.retryMaxDelayMs ?? 30_000);
  const stableConnectionMs = Math.max(1, options.stableConnectionMs ?? 30_000);
  setGaugeMetric('device_bridge_event_stream_connected', 0, { transport: 'usbmux' });
  while (!signal.aborted) {
    let stopStream: (() => void) | undefined;
    let resolveStreamFailure: (error: Error) => void = () => {};
    let firstEventAt: number | undefined;
    const streamFailure = new Promise<Error>((resolve) => {
      resolveStreamFailure = resolve;
    });
    const stopping = abortWait(signal);
    try {
      stopStream = await subscribeWithInitialSnapshotDeadline(
        subscriber,
        (event) => {
          firstEventAt ??= Date.now();
          setGaugeMetric('device_bridge_event_stream_connected', 1, { transport: 'usbmux' });
          tracker.record(event);
        },
        resolveStreamFailure,
        signal,
        options.initialSnapshotTimeoutMs ?? 10_000,
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
      const retry = calculateRustDeviceEventRetry(failures, firstEventAt, Date.now(), stableConnectionMs, retryBaseDelayMs, retryMaxDelayMs);
      failures = retry.failures;
      incrementMetric('device_bridge_event_stream_failures_total');
      log.warn('Rust device bridge event stream unavailable; reconnecting', { error: error instanceof Error ? error.message : String(error) });
      await delayWithSignal(retry.delayMs, signal).catch(() => {});
    } finally {
      stopping.dispose();
      stopStream?.();
    }
  }
  setGaugeMetric('device_bridge_event_stream_connected', 0, { transport: 'usbmux' });
}

let activeMonitor: { controller: AbortController; task: Promise<void> } | undefined;

export function startRustDeviceEventMonitoring(options: RustDeviceEventMonitoringOptions = {}): () => Promise<void> {
  if (activeMonitor) {
    const current = activeMonitor;
    return async () => {
      current.controller.abort();
      await current.task;
    };
  }
  const controller = new AbortController();
  const monitor = { controller, task: Promise.resolve() };
  monitor.task = monitorRustDeviceEvents(controller.signal, options).finally(() => {
    if (activeMonitor === monitor) activeMonitor = undefined;
  });
  activeMonitor = monitor;
  return async () => {
    controller.abort();
    await monitor.task;
  };
}
