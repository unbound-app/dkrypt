export const pwaState = $state<{ updateAvailable: boolean; canInstall: boolean }>({ updateAvailable: false, canInstall: false });

let waitingWorker: ServiceWorker | null = null;
let deferredInstallPrompt: { prompt: () => void; userChoice: Promise<unknown> } | null = null;

// Detects a new service-worker version once it's installed-but-waiting (i.e. an update actually
// shipped, not the very first install) and offers a manual reload instead of taking over silently
// mid-session, which would otherwise interrupt whatever the user is doing.
export function initPwaUpdateWatcher(registration: ServiceWorkerRegistration): void {
  if (registration.waiting && navigator.serviceWorker.controller) {
    waitingWorker = registration.waiting;
    pwaState.updateAvailable = true;
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        waitingWorker = installing;
        pwaState.updateAvailable = true;
      }
    });
  });

  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

export function applyPwaUpdate(): void {
  waitingWorker?.postMessage('skipWaiting');
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
