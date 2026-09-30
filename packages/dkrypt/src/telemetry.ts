import { randomBytes } from 'node:crypto';
import { trackBackgroundWork } from '#backgroundWork.js';
import { config } from '#config.js';
import { getOtelResourceAttributes } from '#deployment.js';
import { createOtlpMetricsPayload, incrementMetric } from '#metrics.js';

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceparent: string;
}

type OtlpAttributeValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number };

interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  flags: number;
  status: { code: number; message?: string };
}

export interface SpanHandle {
  context: TraceContext;
  setAttributes(attributes: Record<string, string | number | boolean | undefined>): void;
  end(error?: unknown): void;
}

const pendingSpans: SpanRecord[] = [];
let flushTimer: ReturnType<typeof setInterval> | undefined;
let flushInFlight: Promise<void> | undefined;
let metricsFlushInFlight: Promise<void> | undefined;
const otlpSignalConfig = {
  traces: { endpoint: config.otelExporterOtlpTracesEndpoint, headers: config.otelExporterOtlpTracesHeaders },
  metrics: { endpoint: config.otelExporterOtlpMetricsEndpoint, headers: config.otelExporterOtlpMetricsHeaders },
};

function hexBytes(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function validTraceId(value: string | undefined): value is string {
  return !!value && /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value);
}

function validSpanId(value: string | undefined): value is string {
  return !!value && /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value);
}

function traceparentFor(traceId: string, spanId: string, traceFlags: number): string {
  return `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, '0')}`;
}

function parseTraceparent(header: string | undefined): TraceContext | undefined {
  if (!header || header.length < 55) return undefined;
  const version = header.slice(0, 2);
  if (!/^[0-9a-f]{2}$/.test(version) || version === 'ff') return undefined;
  if (header[2] !== '-' || header[35] !== '-' || header[52] !== '-') return undefined;
  const traceId = header.slice(3, 35);
  const spanId = header.slice(36, 52);
  const flagsValue = header.slice(53, 55);
  if (!/^[0-9a-f]{2}$/.test(flagsValue) || !validTraceId(traceId) || !validSpanId(spanId)) return undefined;
  if (version === '00' && header.length !== 55) return undefined;
  if (version !== '00' && header.length > 55 && (header[55] !== '-' || header.length === 56)) return undefined;
  const traceFlags = Number.parseInt(flagsValue, 16) & 3;
  return { traceId, spanId, traceFlags, traceparent: traceparentFor(traceId, spanId, traceFlags) };
}

export function traceContextFromHeader(header: string | undefined): TraceContext {
  const parsed = parseTraceparent(header);
  if (parsed) return parsed;
  const generatedTraceId = hexBytes(16);
  const generatedSpanId = hexBytes(8);
  const sampleRate = Math.min(1, Math.max(0, config.otelSampleRate));
  const traceFlags = 2 | (Math.random() < sampleRate ? 1 : 0);
  return {
    traceId: generatedTraceId,
    spanId: generatedSpanId,
    traceFlags,
    traceparent: traceparentFor(generatedTraceId, generatedSpanId, traceFlags),
  };
}

function attributeEntries(attributes: Record<string, string | number | boolean | undefined>): OtlpAttribute[] {
  const entries: OtlpAttribute[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'string') entries.push({ key, value: { stringValue: value } });
    else if (typeof value === 'boolean') entries.push({ key, value: { boolValue: value } });
    else if (typeof value === 'number' && Number.isFinite(value)) {
      entries.push(Number.isSafeInteger(value)
        ? { key, value: { intValue: String(value) } }
        : { key, value: { doubleValue: value } });
    }
  }
  return entries;
}

export function resolveOtlpEndpoint(signal: 'traces' | 'metrics', signalEndpoint: string | undefined, sharedEndpoint: string | undefined): string | undefined {
  const direct = signalEndpoint?.trim();
  if (direct) return direct;
  const shared = sharedEndpoint?.trim();
  if (!shared) return undefined;
  const normalized = shared.replace(/\/+$/, '');
  const signalPath = `/v1/${signal}`;
  if (normalized.endsWith(signalPath)) return normalized;
  if (/\/v1\/(traces|metrics)$/.test(normalized)) return normalized.replace(/\/v1\/(traces|metrics)$/, signalPath);
  return `${normalized}${signalPath}`;
}

function endpoint(signal: 'traces' | 'metrics'): string | undefined {
  return resolveOtlpEndpoint(signal, otlpSignalConfig[signal].endpoint, config.otelExporterOtlpEndpoint);
}

function parseHeaders(value: string): Array<[string, string]> {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const separator = entry.indexOf('=');
    return separator === -1 ? [entry, ''] : [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
  });
}

function exporterHeaders(signal: 'traces' | 'metrics'): Record<string, string> {
  const values = new Map<string, [string, string]>([[
    'user-agent', ['User-Agent', `dkrypt-otlp-exporter/1.0.0 (Bun/${process.versions.bun ?? process.version})`],
  ]]);
  for (const [name, value] of [...parseHeaders(config.otelExporterOtlpHeaders), ...parseHeaders(otlpSignalConfig[signal].headers)]) {
    values.set(name.toLowerCase(), [name, value]);
  }
  return Object.fromEntries(values.values());
}

function enqueueSpan(span: SpanRecord): void {
  if (pendingSpans.length >= config.otelMaxQueueSize) {
    incrementMetric('telemetry_spans_dropped_total');
    return;
  }
  pendingSpans.push(span);
}

function requeueSpans(spans: SpanRecord[]): void {
  pendingSpans.unshift(...spans);
  const overflow = pendingSpans.length - config.otelMaxQueueSize;
  if (overflow <= 0) return;
  pendingSpans.splice(config.otelMaxQueueSize);
  incrementMetric('telemetry_spans_dropped_total', {}, overflow);
}

type OtlpFetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function postOtlpJson(signal: 'traces' | 'metrics', url: string, payload: unknown, fetcher: OtlpFetcher = fetch): Promise<number> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...exporterHeaders(signal) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`OTLP ${signal} exporter returned HTTP ${response.status}`);
  const responseText = await response.text();
  if (!responseText.trim()) throw new Error(`OTLP ${signal} exporter returned an empty success response`);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(responseText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('response must be a JSON object');
    body = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`OTLP ${signal} exporter returned an invalid success response: ${error instanceof Error ? error.message : String(error)}`);
  }
  const partialSuccessValue = Object.hasOwn(body, 'partialSuccess') ? body.partialSuccess : body.partial_success;
  if (partialSuccessValue !== undefined && (!partialSuccessValue || typeof partialSuccessValue !== 'object' || Array.isArray(partialSuccessValue))) {
    throw new Error(`OTLP ${signal} exporter returned an invalid partial success response`);
  }
  const partialSuccess = partialSuccessValue as Record<string, unknown> | undefined;
  const rejectedField = signal === 'metrics' ? 'rejectedDataPoints' : 'rejectedSpans';
  const snakeField = signal === 'metrics' ? 'rejected_data_points' : 'rejected_spans';
  const rejectedValue = partialSuccess && Object.hasOwn(partialSuccess, rejectedField)
    ? partialSuccess[rejectedField]
    : partialSuccess?.[snakeField];
  if (rejectedValue === undefined) return 0;
  const rejected = typeof rejectedValue === 'string' && /^\d+$/.test(rejectedValue) ? Number(rejectedValue) : rejectedValue;
  if (typeof rejected !== 'number' || !Number.isSafeInteger(rejected) || rejected < 0) {
    throw new Error(`OTLP ${signal} exporter returned an invalid rejected count`);
  }
  return rejected;
}

export function startSpan(name: string, attributes: Record<string, string | number | boolean | undefined> = {}, parent?: TraceContext): SpanHandle {
  const parentContext = parent ?? traceContextFromHeader(undefined);
  const spanId = hexBytes(8);
  const context: TraceContext = {
    traceId: parentContext.traceId,
    spanId,
    traceFlags: parentContext.traceFlags,
    traceparent: traceparentFor(parentContext.traceId, spanId, parentContext.traceFlags),
  };
  if ((context.traceFlags & 1) === 0) return { context, setAttributes() {}, end() {} };
  const start = process.hrtime.bigint();
  const mutable = new Map(Object.entries(attributes).filter(([, value]) => value !== undefined));
  let ended = false;
  return {
    context,
    setAttributes(next) {
      for (const [key, value] of Object.entries(next)) if (value !== undefined) mutable.set(key, value);
    },
    end(error) {
      if (ended) return;
      ended = true;
      const duration = process.hrtime.bigint() - start;
      const record: SpanRecord = {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: parent?.spanId,
        name,
        startTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n - duration),
        endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
        attributes: attributeEntries(Object.fromEntries(mutable)),
        flags: context.traceFlags,
        status: error ? { code: 2, message: error instanceof Error ? error.message : String(error) } : { code: 1 },
      };
      enqueueSpan(record);
      incrementMetric('telemetry_spans_finished_total', { name });
      if (pendingSpans.length >= Math.max(1, config.otelBatchSize)) void flushTelemetry();
    },
  };
}

export interface OtlpTraceFlushOptions {
  endpoint?: string;
  fetcher?: OtlpFetcher;
}

export async function flushTelemetry(options: OtlpTraceFlushOptions = {}): Promise<void> {
  const url = options.endpoint ?? endpoint('traces');
  if (!url || pendingSpans.length === 0) return;
  if (flushInFlight) return flushInFlight;
  const spans = pendingSpans.splice(0, Math.max(1, config.otelBatchSize));
  const fetcher = options.fetcher ?? fetch;
  flushInFlight = Promise.resolve()
    .then(() => postOtlpJson('traces', url, {
      resourceSpans: [{
        resource: { attributes: getOtelResourceAttributes(config.otelServiceName) },
        scopeSpans: [{ spans }],
      }],
    }, fetcher))
    .then((rejectedSpans) => {
      incrementMetric('telemetry_spans_exported_total', {}, Math.max(0, spans.length - rejectedSpans));
      if (rejectedSpans > 0) incrementMetric('telemetry_spans_rejected_total', {}, rejectedSpans);
    })
    .catch(() => {
      requeueSpans(spans);
      incrementMetric('telemetry_export_failures_total');
    })
    .finally(() => {
      flushInFlight = undefined;
    });
  return flushInFlight;
}

export interface OtlpMetricsFlushOptions {
  endpoint?: string;
  fetcher?: OtlpFetcher;
}

export async function flushOtlpMetrics(options: OtlpMetricsFlushOptions = {}): Promise<void> {
  const url = options.endpoint ?? endpoint('metrics');
  if (!url) return;
  if (metricsFlushInFlight) return metricsFlushInFlight;
  const payload = createOtlpMetricsPayload(config.otelServiceName);
  if (payload.resourceMetrics[0].scopeMetrics[0].metrics.length === 0) return;
  const fetcher = options.fetcher ?? fetch;
  metricsFlushInFlight = Promise.resolve()
    .then(() => postOtlpJson('metrics', url, payload, fetcher))
    .then((rejectedDataPoints) => {
      incrementMetric('telemetry_metrics_exported_total');
      if (rejectedDataPoints > 0) incrementMetric('telemetry_metrics_rejected_points_total', {}, rejectedDataPoints);
    })
    .catch(() => {
      incrementMetric('telemetry_metrics_export_failures_total');
    })
    .finally(() => {
      metricsFlushInFlight = undefined;
    });
  return metricsFlushInFlight;
}

export function startTelemetry(): void {
  if (flushTimer || (!endpoint('traces') && !endpoint('metrics'))) return;
  flushTimer = setInterval(() => {
    void trackBackgroundWork('telemetry-export', async () => {
      await Promise.all([flushTelemetry(), flushOtlpMetrics()]);
    }).catch(() => undefined);
  }, Math.max(1000, config.otelFlushIntervalMs));
  flushTimer.unref();
}

export async function stopTelemetry(): Promise<void> {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = undefined;
  await Promise.all([flushTelemetry(), flushOtlpMetrics()]);
}
