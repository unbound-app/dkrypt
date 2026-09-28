const keyQueues = new Map<string, Promise<void>>();

export async function runKeyedSerial<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = keyQueues.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  keyQueues.set(key, tail);
  await previous;

  try {
    return await operation();
  } finally {
    release();
    if (keyQueues.get(key) === tail) keyQueues.delete(key);
  }
}
