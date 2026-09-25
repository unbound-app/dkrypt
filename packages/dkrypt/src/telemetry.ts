import { randomBytes } from 'node:crypto';
import { config } from '#config.js';
import { createOtlpMetricsPayload, incrementMetric } from '#metrics.js';

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceparent: string;
}

interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue: string } }>;
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
  return !!value && /^[0-9a-f]{32}$/i.test(value) && !/^0+$/.test(value);
}

function validSpanId(value: string | undefined): value is string {
  return !!value && /^[0-9a-f]{16}$/i.test(value) && !/^0+$/.test(value);
}

export function traceContextFromHeader(header: string | undefined): TraceContext {
  const match = header?.match(/^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i);
  const traceId = validTraceId(match?.[2]) ? match[2].toLowerCase() : hexBytes(16);
  const spanId = validSpanId(match?.[3]) ? match[3].toLowerCase() : hexBytes(8);
  return { traceId, spanId, traceparent: match?.[0] ?? `00-${traceId}-${spanId}-01` };
}

function attributeEntries(attributes: Record<string, string | number | boolean | undefined>): Array<{ key: string; value: { stringValue: string } }> {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ key, value: { stringValue: String(value) } }));
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

type OtlpFetcher = (input: string, init?: RequestInit) => Promise<Response>;

async function postOtlpJson(signal: 'traces' | 'metrics', url: string, payload: unknown, fetcher: OtlpFetcher = fetch): Promise<number> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...exporterHeaders(signal) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`OTLP ${signal} exporter returned HTTP ${response.status}`);
  const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
  const partialSuccess = (body?.partialSuccess ?? body?.partial_success) as Record<string, unknown> | undefined;
  const rejectedField = signal === 'metrics' ? 'rejectedDataPoints' : 'rejectedSpans';
  const snakeField = signal === 'metrics' ? 'rejected_data_points' : 'rejected_spans';
  const rejected = Number(partialSuccess?.[rejectedField] ?? partialSuccess?.[snakeField] ?? 0);
  return Number.isSafeInteger(rejected) && rejected > 0 ? rejected : 0;
}

export function startSpan(name: string, attributes: Record<string, string | number | boolean | undefined> = {}, parent?: TraceContext): SpanHandle {
  const sampleRate = Math.min(1, Math.max(0, config.otelSampleRate));
  const parentContext = parent ?? traceContextFromHeader(undefined);
  const spanId = hexBytes(8);
  const context: TraceContext = {
    traceId: parentContext.traceId,
    spanId,
    traceparent: `00-${parentContext.traceId}-${spanId}-01`,
  };
  if (sampleRate === 0 || Math.random() > sampleRate) return { context, setAttributes() {}, end() {} };
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
        status: error ? { code: 2, message: error instanceof Error ? error.message : String(error) } : { code: 1 },
      };
      pendingSpans.push(record);
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
        resource: { attributes: [{ key: 'service.name', value: { stringValue: config.otelServiceName } }] },
        scopeSpans: [{ spans }],
      }],
    }, fetcher))
    .then((rejectedSpans) => {
      incrementMetric('telemetry_spans_exported_total', {}, Math.max(0, spans.length - rejectedSpans));
      if (rejectedSpans > 0) incrementMetric('telemetry_spans_rejected_total', {}, rejectedSpans);
    })
    .catch(() => {
      pendingSpans.unshift(...spans);
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
    void Promise.all([flushTelemetry(), flushOtlpMetrics()]);
  }, Math.max(1000, config.otelFlushIntervalMs));
  flushTimer.unref();
}

export async function stopTelemetry(): Promise<void> {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = undefined;
  await Promise.all([flushTelemetry(), flushOtlpMetrics()]);
}
