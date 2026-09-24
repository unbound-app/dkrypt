import { expect, test } from 'bun:test';
import { startSpan, traceContextFromHeader } from '#telemetry.js';

test('trace contexts preserve incoming trace identity and create valid child spans', () => {
  const parent = traceContextFromHeader('00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');
  expect(parent.traceId).toBe('0123456789abcdef0123456789abcdef');
  expect(parent.spanId).toBe('0123456789abcdef');
  const child = startSpan('test', { operation: 'unit' }, parent);
  expect(child.context.traceId).toBe(parent.traceId);
  expect(child.context.spanId).not.toBe(parent.spanId);
  expect(child.context.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  child.end();
});
