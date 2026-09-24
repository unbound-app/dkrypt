import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceContext } from '#telemetry.js';

export interface CorrelationContext {
  correlationId: string;
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
