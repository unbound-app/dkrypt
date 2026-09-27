import { AsyncLocalStorage } from 'node:async_hooks';
import { startSpan, type SpanHandle, type TraceContext } from '#telemetry.js';

export interface CorrelationContext {
  correlationId: string;
  parentCorrelationId?: string;
  traceId?: string;
  traceContext?: TraceContext;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function withCorrelation<T>(context: CorrelationContext, operation: () => T): T {
  return storage.run(context, operation);
}

export function currentCorrelation(): CorrelationContext | undefined {
  return storage.getStore();
}

export async function withCorrelationSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  operation: (span: SpanHandle) => Promise<T>,
): Promise<T> {
  const parent = currentCorrelation();
  const span = startSpan(name, attributes, parent?.traceContext);
  return withCorrelation({
    correlationId: parent?.correlationId ?? span.context.traceId,
    ...(parent?.parentCorrelationId ? { parentCorrelationId: parent.parentCorrelationId } : {}),
    traceId: span.context.traceId,
    traceContext: span.context,
  }, async () => {
    try {
      const result = await operation(span);
      span.end();
      return result;
    } catch (error) {
      span.end(error);
      throw error;
    }
  });
}
