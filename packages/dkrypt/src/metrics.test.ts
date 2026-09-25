import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createOtlpMetricsPayload, incrementMetric, observeMetric, renderMetrics, resetMetrics, setGaugeMetric } from '#metrics.js';
import { config } from '#config.js';
import { flushOtlpMetrics, flushTelemetry, resolveOtlpEndpoint, startSpan } from '#telemetry.js';

describe('OpenTelemetry metrics', () => {
  beforeEach(() => resetMetrics());
  afterEach(() => resetMetrics());

  it('builds cumulative sums and histograms with typed attributes', () => {
    incrementMetric('jobs_started_total', { source: 'testflight', queued: true }, 2);
    observeMetric('job_duration_ms', 42, { source: 'testflight' });
    observeMetric('job_duration_ms', 350, { source: 'testflight' });
    setGaugeMetric('devices_available', 1, { transport: 'usb' });

    const timestamp = Date.now();
    const payload = createOtlpMetricsPayload('dkrypt', timestamp);
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const sum = metrics.find((metric) => metric.name === 'dkrypt_jobs_started_total')?.sum;
    const histogram = metrics.find((metric) => metric.name === 'dkrypt_job_duration_ms')?.histogram;
    const gauge = metrics.find((metric) => metric.name === 'dkrypt_devices_available')?.gauge;

    expect(payload.resourceMetrics[0].resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'dkrypt' } });
    expect(sum).toMatchObject({ aggregationTemporality: 2, isMonotonic: true });
    expect(sum?.dataPoints).toContainEqual(expect.objectContaining({
      attributes: [
        { key: 'queued', value: { boolValue: true } },
        { key: 'source', value: { stringValue: 'testflight' } },
      ],
      asInt: '2',
      timeUnixNano: String(BigInt(timestamp) * 1000000n),
    }));
    expect(histogram?.aggregationTemporality).toBe(2);
    expect(histogram?.dataPoints).toContainEqual(expect.objectContaining({
      count: '2',
      sum: 392,
      timeUnixNano: String(BigInt(timestamp) * 1000000n),
      explicitBounds: expect.any(Array),
      bucketCounts: expect.any(Array),
    }));
    expect(gauge?.dataPoints).toContainEqual(expect.objectContaining({
      attributes: [{ key: 'transport', value: { stringValue: 'usb' } }],
      asDouble: 1,
      timeUnixNano: String(BigInt(timestamp) * 1000000n),
    }));
  });

  it('bounds series cardinality and reports dropped measurements', () => {
    for (let index = 0; index < 5000; index += 1) incrementMetric('high_cardinality_total', { key: String(index) });

    const payload = createOtlpMetricsPayload('dkrypt', Date.now());
    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const highCardinality = metrics.find((metric) => metric.name === 'dkrypt_high_cardinality_total')?.sum?.dataPoints;
    const dropped = metrics.find((metric) => metric.name === 'dkrypt_metric_series_dropped_total')?.sum?.dataPoints;

    expect(highCardinality).toHaveLength(2048);
    expect(dropped?.[0].asInt).toBe('2952');
    expect(renderMetrics()).toContain('dkrypt_metric_series_dropped_total 2952');
  });

  it('resolves shared and signal-specific OTLP endpoints', () => {
    expect(resolveOtlpEndpoint('metrics', undefined, 'https://collector.example')).toBe('https://collector.example/v1/metrics');
    expect(resolveOtlpEndpoint('metrics', undefined, 'https://collector.example/v1/traces')).toBe('https://collector.example/v1/metrics');
    expect(resolveOtlpEndpoint('metrics', 'https://collector.example/custom', 'https://collector.example')).toBe('https://collector.example/custom');
    expect(resolveOtlpEndpoint('metrics', 'https://collector.example/v1/metrics/', 'https://collector.example')).toBe('https://collector.example/v1/metrics/');
    expect(resolveOtlpEndpoint('traces', undefined, '')).toBeUndefined();
  });

  it('retries cumulative measurements after a collector failure', async () => {
    incrementMetric('jobs_completed_total', { source: 'appstore' });
    const failed = await flushOtlpMetrics({
      endpoint: 'https://collector.example/v1/metrics',
      fetcher: async () => new Response(null, { status: 503 }),
    });
    let body: Record<string, any> | undefined;
    await flushOtlpMetrics({
      endpoint: 'https://collector.example/v1/metrics',
      fetcher: async (_input, init) => {
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
        expect(new Headers(init?.headers).get('user-agent')).toStartWith('dkrypt-otlp-exporter/1.0.0 (Bun/');
        body = JSON.parse(String(init?.body));
        return Response.json({});
      },
    });
    const retriedMetrics = body?.resourceMetrics[0].scopeMetrics[0].metrics;
    let successfulBody: Record<string, any> | undefined;
    await flushOtlpMetrics({
      endpoint: 'https://collector.example/v1/metrics',
      fetcher: async (_input, init) => {
        successfulBody = JSON.parse(String(init?.body));
        return Response.json({});
      },
    });
    const successfulMetrics = successfulBody?.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(failed).toBeUndefined();
    expect(retriedMetrics.find((metric: any) => metric.name === 'dkrypt_jobs_completed_total')?.sum.dataPoints[0].asInt).toBe('1');
    expect(retriedMetrics.find((metric: any) => metric.name === 'dkrypt_telemetry_metrics_export_failures_total')?.sum.dataPoints[0].asInt).toBe('1');
    expect(successfulMetrics.find((metric: any) => metric.name === 'dkrypt_telemetry_metrics_exported_total')?.sum.dataPoints[0].asInt).toBe('1');
  });

  it('records OTLP partial rejection without retrying accepted metrics', async () => {
    incrementMetric('jobs_completed_total', { source: 'appstore' });
    let requests = 0;
    await flushOtlpMetrics({
      endpoint: 'https://collector.example/v1/metrics',
      fetcher: async () => {
        requests += 1;
        return Response.json({ partialSuccess: { rejectedDataPoints: '2', errorMessage: 'one series rejected' } });
      },
    });
    let nextBody: Record<string, any> | undefined;
    await flushOtlpMetrics({
      endpoint: 'https://collector.example/v1/metrics',
      fetcher: async (_input, init) => {
        nextBody = JSON.parse(String(init?.body));
        return Response.json({});
      },
    });
    const metrics = nextBody?.resourceMetrics[0].scopeMetrics[0].metrics;

    expect(requests).toBe(1);
    expect(metrics.find((metric: any) => metric.name === 'dkrypt_telemetry_metrics_rejected_points_total')?.sum.dataPoints[0].asInt).toBe('2');
  });

  it('records OTLP partial rejection for spans', async () => {
    const originalSampleRate = config.otelSampleRate;
    config.otelSampleRate = 1;
    try {
      startSpan('test.partial-span').end();
      await flushTelemetry({
        endpoint: 'https://collector.example/v1/traces',
        fetcher: async () => Response.json({ partialSuccess: { rejectedSpans: '1', errorMessage: 'span rejected' } }),
      });
      const metrics = createOtlpMetricsPayload('dkrypt').resourceMetrics[0].scopeMetrics[0].metrics;

      expect(metrics.find((metric) => metric.name === 'dkrypt_telemetry_spans_rejected_total')?.sum?.dataPoints[0].asInt).toBe('1');
    } finally {
      config.otelSampleRate = originalSampleRate;
    }
  });

  it('treats empty and malformed 2xx responses as exporter failures', async () => {
    incrementMetric('jobs_completed_total', { source: 'appstore' });
    for (const response of [new Response(null, { status: 200 }), new Response('{', { status: 200 })]) {
      await flushOtlpMetrics({
        endpoint: 'https://collector.example/v1/metrics',
        fetcher: async () => response,
      });
    }
    let body: Record<string, any> | undefined;
    await flushOtlpMetrics({
      endpoint: 'https://collector.example/v1/metrics',
      fetcher: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Response.json({});
      },
    });
    const metrics = body?.resourceMetrics[0].scopeMetrics[0].metrics;

    expect(metrics.find((metric: any) => metric.name === 'dkrypt_telemetry_metrics_export_failures_total')?.sum.dataPoints[0].asInt).toBe('2');
  });
});
