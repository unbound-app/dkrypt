import { randomBytes } from 'node:crypto';
import { config } from '#config.js';
import { incrementMetric } from '#metrics.js';

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

function endpoint(): string | undefined {
  if (!config.otelExporterOtlpEndpoint) return undefined;
  const value = config.otelExporterOtlpEndpoint.replace(/\/$/, '');
  return value.endsWith('/v1/traces') ? value : `${value}/v1/traces`;
}

function exporterHeaders(): Record<string, string> {
  return Object.fromEntries(
    config.otelExporterOtlpHeaders
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('=');
        return separator === -1 ? [entry, ''] : [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
      }),
  );
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

export async function flushTelemetry(): Promise<void> {
  const url = endpoint();
  if (!url || pendingSpans.length === 0) return;
  if (flushInFlight) return flushInFlight;
  const spans = pendingSpans.splice(0, Math.max(1, config.otelBatchSize));
  flushInFlight = fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...exporterHeaders() },
    body: JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: config.otelServiceName } }] },
        scopeSpans: [{ spans }],
      }],
    }),
    signal: AbortSignal.timeout(5000),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`OTLP exporter returned HTTP ${response.status}`);
      incrementMetric('telemetry_spans_exported_total', {}, spans.length);
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

export function startTelemetry(): void {
  if (flushTimer || !endpoint()) return;
  flushTimer = setInterval(() => void flushTelemetry(), Math.max(1000, config.otelFlushIntervalMs));
  flushTimer.unref();
}

export function stopTelemetry(): Promise<void> {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = undefined;
  return flushTelemetry();
}
