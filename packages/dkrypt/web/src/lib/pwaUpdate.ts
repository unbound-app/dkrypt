let activationPending = false;

export function watchPwaUpdate(
  registration: ServiceWorkerRegistration,
  serviceWorker: Pick<ServiceWorkerContainer, 'controller' | 'addEventListener'>,
  onUpdateAvailable: (worker: ServiceWorker) => void,
): void {
  const reportWaitingUpdate = () => {
    const waitingWorker = registration.waiting;
    if (waitingWorker && serviceWorker.controller) onUpdateAvailable(waitingWorker);
  };

  reportWaitingUpdate();
  serviceWorker.addEventListener('controllerchange', reportWaitingUpdate);
  registration.addEventListener('updatefound', () => {
    const installingWorker = registration.installing;
    if (!installingWorker) return;
    installingWorker.addEventListener('statechange', () => {
      if (installingWorker.state === 'installed' && serviceWorker.controller) onUpdateAvailable(installingWorker);
    });
  });
}

export function activatePwaUpdate(
  worker: ServiceWorker | null | undefined,
  serviceWorker: Pick<ServiceWorkerContainer, 'controller' | 'addEventListener' | 'removeEventListener'>,
  reload: () => void,
  onTimeout: () => void = () => undefined,
  activationTimeoutMs = 5000,
): void {
  if (!worker) return;
  if (serviceWorker.controller === worker) {
    reload();
    return;
  }
  if (activationPending) return;

  activationPending = true;
  let finished = false;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = (callback: () => void) => {
    if (finished) return;
    finished = true;
    activationPending = false;
    clearTimeout(reloadTimer);
    serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    callback();
  };
  const handleControllerChange = () => {
    if (serviceWorker.controller === worker) settle(reload);
  };

  serviceWorker.addEventListener('controllerchange', handleControllerChange);
  reloadTimer = setTimeout(() => settle(onTimeout), activationTimeoutMs);
  try {
    worker.postMessage('skipWaiting');
  } catch {
    settle(onTimeout);
  }
}
