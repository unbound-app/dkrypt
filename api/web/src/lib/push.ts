import { fetchPushPublicKey, subscribePush, unsubscribePush } from '#lib/api';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!pushSupported()) return undefined;
  return navigator.serviceWorker.register('/sw.js');
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

export async function enablePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    await subscribePush(existing.toJSON() as PushSubscriptionJSON);
    return true;
  }

  const { publicKey } = await fetchPushPublicKey();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await subscribePush(subscription.toJSON() as PushSubscriptionJSON);
  return true;
}

export async function disablePush(): Promise<void> {
  const existing = await getExistingPushSubscription();
  if (!existing) return;
  await unsubscribePush(existing.endpoint);
  await existing.unsubscribe();
}
