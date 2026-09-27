interface ActiveBackgroundWork {
  name: string;
  promise: Promise<unknown>;
}

export interface BackgroundWorkDrain {
  drained: boolean;
  pending: string[];
  completion: Promise<void>;
}

const activeBackgroundWork = new Set<ActiveBackgroundWork>();

export function trackBackgroundWork<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
  const promise = Promise.resolve().then(operation);
  const work: ActiveBackgroundWork = { name, promise };
  activeBackgroundWork.add(work);
  void work.promise.then(
    () => activeBackgroundWork.delete(work),
    () => activeBackgroundWork.delete(work),
  );
  return promise;
}

async function waitForBackgroundWork(): Promise<void> {
  while (activeBackgroundWork.size > 0) {
    const running = [...activeBackgroundWork];
    await Promise.allSettled(running.map((work) => work.promise));
  }
}

export async function drainBackgroundWork(timeoutMs: number): Promise<BackgroundWorkDrain> {
  const completion = waitForBackgroundWork();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    completion.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  return {
    drained,
    pending: [...new Set([...activeBackgroundWork].map((work) => work.name))],
    completion,
  };
}
