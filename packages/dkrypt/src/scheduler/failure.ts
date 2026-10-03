import { classifyJobFailure, type JobFailureClass } from '#util/failureCategory.js';

export interface SchedulerFailure {
  failureClass: JobFailureClass;
  retryable: boolean;
}

const PERMANENT_HTTP_ERROR_RE = /\bHTTP\s*4(?!(?:03|08|29)\b)\d\d\b/i;
const TRANSIENT_ERROR_RE = /\bHTTP\s*(?:408|429|5\d\d)\b|rate limit|retry after \d+s|temporarily unavailable|timed? ?out|timeout|AbortError|connection reset|connection closed|socket hang up|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|no route to host|device agent connection was lost|could not connect to (?:the dkrypt device agent|the Rust device bridge)/i;
const DEVICE_AGENT_FAILURE_RE = /DeviceAgentUnavailableError|could not connect to (?:the dkrypt device agent|the Rust device bridge)|device agent connection (?:was )?lost/i;
const RATE_LIMIT_ERROR_RE = /rate.?limit|API rate limit|secondary rate limit|abuse detection|retry after \d+s/i;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error ?? '');
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  while (current && typeof current === 'object' && chain.length < 8) {
    const record = current as Record<string, unknown>;
    chain.push(record);
    current = record.cause;
  }
  return chain;
}

function explicitRetryability(error: unknown): boolean | undefined {
  const chain = errorChain(error);
  for (const item of chain) {
    const details = item.details;
    if (details && typeof details === 'object' && typeof (details as Record<string, unknown>).retryable === 'boolean') {
      return (details as Record<string, unknown>).retryable as boolean;
    }
    if (typeof item.retryable === 'boolean') return item.retryable;
  }
  if (chain.some((item) => item.name === 'DeviceAgentUnavailableError')) {
    return !/missing|too short|does not support|unsupported/i.test(toErrorMessage(error));
  }
  return undefined;
}

export function classifySchedulerFailure(error: unknown): SchedulerFailure {
  const message = errorChain(error).map((item) => toErrorMessage(item)).join(' | ') || toErrorMessage(error);
  const failureClass = DEVICE_AGENT_FAILURE_RE.test(message)
    ? 'device_transport'
    : RATE_LIMIT_ERROR_RE.test(message)
      ? 'network'
      : /AbortError/i.test(message)
        ? 'network'
      : classifyJobFailure(message);
  const explicit = explicitRetryability(error);
  if (explicit !== undefined) return { failureClass, retryable: explicit };
  const rateLimitedForbidden = /\bHTTP\s*403\b/i.test(message) && RATE_LIMIT_ERROR_RE.test(message);
  if (PERMANENT_HTTP_ERROR_RE.test(message) && !rateLimitedForbidden) return { failureClass, retryable: false };
  return {
    failureClass,
    retryable: TRANSIENT_ERROR_RE.test(message) || failureClass === 'device_transport',
  };
}

export interface SchedulerRetryOutcome {
  ok: boolean;
  reason: string;
  retryable?: boolean;
}

export interface SchedulerRetryContext {
  attempt: number;
  delayMs: number;
  reason: string;
}

export async function runWithSchedulerRetries<T extends SchedulerRetryOutcome>(
  run: () => Promise<T>,
  retryCount: number,
  wait: (delayMs: number) => Promise<void>,
  onRetry: (context: SchedulerRetryContext) => void,
  retryAfterMsFromReason: (reason: string) => number | undefined,
): Promise<T> {
  const retryBaseDelayMs = 30_000;
  let result = await run();
  for (let attempt = 1; attempt <= retryCount && !result.ok && result.retryable === true; attempt++) {
    const backoffMs = retryBaseDelayMs * 2 ** (attempt - 1);
    const rateLimitedMs = retryAfterMsFromReason(result.reason);
    const delayMs = rateLimitedMs ? Math.max(backoffMs, rateLimitedMs) : backoffMs;
    onRetry({ attempt, delayMs, reason: result.reason });
    await wait(delayMs);
    result = await run();
  }
  return result;
}

export async function checkDestinationsWithRetries<Target, Check extends SchedulerRetryOutcome>(
  targets: Target[],
  checkTarget: (target: Target) => Promise<Check>,
  retryCount: number,
  wait: (delayMs: number) => Promise<void>,
  onRetry: (target: Target, context: SchedulerRetryContext) => void,
  retryAfterMsFromReason: (reason: string) => number | undefined,
): Promise<Check[]> {
  return Promise.all(targets.map((target) => runWithSchedulerRetries(
    () => checkTarget(target),
    retryCount,
    wait,
    (context) => onRetry(target, context),
    retryAfterMsFromReason,
  )));
}
