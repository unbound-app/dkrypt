import { activatePwaUpdate, watchPwaUpdate } from './pwaUpdate';

export const pwaState = $state<{
  updateAvailable: boolean;
  canInstall: boolean;
  updateStatus: 'idle' | 'applying' | 'failed' | 'ready';
}>({ updateAvailable: false, canInstall: false, updateStatus: 'idle' });

let waitingWorker: ServiceWorker | null = null;
let watchedRegistration: ServiceWorkerRegistration | null = null;
let deferredInstallPrompt: { prompt: () => void; userChoice: Promise<unknown> } | null = null;

export function initPwaUpdateWatcher(registration: ServiceWorkerRegistration): void {
  watchedRegistration = registration;
  watchPwaUpdate(registration, navigator.serviceWorker, (worker) => {
    waitingWorker = worker;
    pwaState.updateAvailable = true;
    pwaState.updateStatus = 'idle';
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (pwaState.updateAvailable && !registration.waiting) pwaState.updateStatus = 'ready';
  });
}

export function applyPwaUpdate(): void {
  pwaState.updateStatus = 'applying';
  activatePwaUpdate(
    watchedRegistration?.waiting ?? waitingWorker,
    navigator.serviceWorker,
    () => location.reload(),
    () => { pwaState.updateStatus = 'failed'; },
  );
}

export function initInstallPromptWatcher(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e as unknown as { prompt: () => void; userChoice: Promise<unknown> };
    pwaState.canInstall = true;
  });
  window.addEventListener('appinstalled', () => {
    pwaState.canInstall = false;
    deferredInstallPrompt = null;
  });
}

export async function promptPwaInstall(): Promise<void> {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  pwaState.canInstall = false;
}
