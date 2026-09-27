import { expect, test } from 'bun:test';
import { config } from '#config.js';
import { flushTelemetry, startSpan, traceContextFromHeader } from '#telemetry.js';

test('trace contexts preserve incoming trace identity and create valid child spans', async () => {
  const parent = traceContextFromHeader('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
  expect(parent.traceId).toBe('0123456789abcdef0123456789abcdef');
  expect(parent.spanId).toBe('0123456789abcdef');
  const child = startSpan('test', { operation: 'unit' }, parent);
  expect(child.context.traceId).toBe(parent.traceId);
  expect(child.context.spanId).not.toBe(parent.spanId);
  expect(child.context.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  child.end();
  await flushTelemetry({ endpoint: 'https://collector.example/v1/traces', fetcher: async () => Response.json({}) });
});

test('OTLP spans preserve string, boolean, integer, and floating-point attribute types', async () => {
  const originalSampleRate = config.otelSampleRate;
  const originalBatchSize = config.otelBatchSize;
  config.otelSampleRate = 1;
  config.otelBatchSize = 128;
  try {
    startSpan('test.typed-attributes', {
      'attribute.string': 'value',
      'attribute.boolean': true,
      'attribute.integer': 42,
      'attribute.double': 1.25,
      'attribute.omitted': undefined,
    }).end();

    let payload: any;
    await flushTelemetry({
      endpoint: 'https://collector.example/v1/traces',
      fetcher: async (_input, init) => {
        payload = JSON.parse(String(init?.body));
        return Response.json({});
      },
    });

    const span = payload.resourceSpans[0].scopeSpans[0].spans.find((item: any) => item.name === 'test.typed-attributes');
    const values = Object.fromEntries(span.attributes.map((attribute: any) => [attribute.key, attribute.value]));
    expect(values['attribute.string']).toEqual({ stringValue: 'value' });
    expect(values['attribute.boolean']).toEqual({ boolValue: true });
    expect(values['attribute.integer']).toEqual({ intValue: '42' });
    expect(values['attribute.double']).toEqual({ doubleValue: 1.25 });
    expect(values['attribute.omitted']).toBeUndefined();
    expect(span.flags).toBe(3);
  } finally {
    config.otelSampleRate = originalSampleRate;
    config.otelBatchSize = originalBatchSize;
  }
});

test('trace sampling follows the root decision for local and remote parent contexts', async () => {
  const originalSampleRate = config.otelSampleRate;
  const originalBatchSize = config.otelBatchSize;
  config.otelSampleRate = 0;
  config.otelBatchSize = 128;
  try {
    const root = startSpan('test.unsampled-root');
    config.otelSampleRate = 1;
    const localChild = startSpan('test.unsampled-local-child', {}, root.context);
    const remoteParent = traceContextFromHeader('00-0123456789abcdef0123456789abcdef-0123456789abcdef-00');
    const remoteChild = startSpan('test.unsampled-remote-child', {}, remoteParent);
    root.end();
    localChild.end();
    remoteChild.end();

    expect(root.context.traceparent).toMatch(/-02$/);
    expect(localChild.context.traceparent).toMatch(/-02$/);
    expect(remoteChild.context.traceparent).toMatch(/-00$/);

    let requests = 0;
    await flushTelemetry({
      endpoint: 'https://collector.example/v1/traces',
      fetcher: async () => {
        requests += 1;
        return Response.json({});
      },
    });
    expect(requests).toBe(0);
  } finally {
    config.otelSampleRate = originalSampleRate;
    config.otelBatchSize = originalBatchSize;
  }
});

test('higher traceparent versions preserve known flags and discard unknown flags', async () => {
  const parent = traceContextFromHeader('01-0123456789abcdef0123456789abcdef-0123456789abcdef-83-future-field');
  const child = startSpan('test.future-traceparent', {}, parent);
  expect(parent.traceFlags).toBe(3);
  expect(child.context.traceparent).toBe(`00-${parent.traceId}-${child.context.spanId}-03`);
  child.end();
  await flushTelemetry({ endpoint: 'https://collector.example/v1/traces', fetcher: async () => Response.json({}) });
});
