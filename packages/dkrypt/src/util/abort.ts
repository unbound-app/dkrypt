export function abortedOperationError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === 'string' ? reason : 'operation aborted');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedOperationError(signal);
}

export function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortedOperationError(signal));
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
