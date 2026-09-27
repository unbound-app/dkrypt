import { describe, expect, test } from 'bun:test';
import { activatePwaUpdate, watchPwaUpdate } from './pwaUpdate';

describe('PWA update activation', () => {
  test('reports a waiting update only after an active worker controls the page', () => {
    const serviceWorker = new EventTarget() as ServiceWorkerContainer;
    Object.defineProperty(serviceWorker, 'controller', { configurable: true, value: {} });
    const waitingWorker = { state: 'installed' } as ServiceWorker;
    const registration = new EventTarget() as ServiceWorkerRegistration;
    Object.defineProperty(registration, 'waiting', { configurable: true, value: waitingWorker });
    const updates: ServiceWorker[] = [];

    watchPwaUpdate(registration, serviceWorker, (worker) => updates.push(worker));

    expect(updates).toEqual([waitingWorker]);
  });

  test('reports an existing waiting update after the initial worker takes control', () => {
    let controlled = false;
    const serviceWorker = new EventTarget() as ServiceWorkerContainer;
    Object.defineProperty(serviceWorker, 'controller', { get: () => controlled ? {} : null });
    const waitingWorker = { state: 'installed' } as ServiceWorker;
    const registration = new EventTarget() as ServiceWorkerRegistration;
    Object.defineProperty(registration, 'waiting', { configurable: true, value: waitingWorker });
    const updates: ServiceWorker[] = [];

    watchPwaUpdate(registration, serviceWorker, (worker) => updates.push(worker));
    expect(updates).toEqual([]);
    controlled = true;
    serviceWorker.dispatchEvent(new Event('controllerchange'));

    expect(updates).toEqual([waitingWorker]);
  });

  test('reports a newly installed worker without reloading the page', () => {
    const serviceWorker = new EventTarget() as ServiceWorkerContainer;
    Object.defineProperty(serviceWorker, 'controller', { configurable: true, value: {} });
    const installingWorker = new EventTarget() as ServiceWorker;
    Object.defineProperty(installingWorker, 'state', { configurable: true, value: 'installed' });
    const registration = new EventTarget() as ServiceWorkerRegistration;
    Object.defineProperty(registration, 'installing', { configurable: true, value: installingWorker });
    let reloadCount = 0;
    const reload = () => reloadCount++;
    const updates: ServiceWorker[] = [];
    watchPwaUpdate(registration, serviceWorker, (worker) => updates.push(worker));
    registration.dispatchEvent(new Event('updatefound'));
    installingWorker.dispatchEvent(new Event('statechange'));

    expect(updates).toEqual([installingWorker]);
    expect(reloadCount).toBe(0);
  });

  test('reloads only after the new worker takes control', async () => {
    const messages: unknown[] = [];
    const serviceWorker = new EventTarget();
    let controller: ServiceWorker | null = {} as ServiceWorker;
    Object.defineProperty(serviceWorker, 'controller', { get: () => controller });
    let reloadCount = 0;
    let timeoutCount = 0;
    const worker = { postMessage: (message: unknown) => messages.push(message) } as ServiceWorker;

    activatePwaUpdate(worker, serviceWorker, () => reloadCount++, () => timeoutCount++, 500);
    activatePwaUpdate(worker, serviceWorker, () => reloadCount++, () => timeoutCount++, 500);

    expect(messages).toEqual(['skipWaiting']);
    expect(reloadCount).toBe(0);
    controller = {} as ServiceWorker;
    serviceWorker.dispatchEvent(new Event('controllerchange'));
    expect(reloadCount).toBe(0);
    controller = worker;
    serviceWorker.dispatchEvent(new Event('controllerchange'));
    expect(reloadCount).toBe(1);
    expect(timeoutCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(reloadCount).toBe(1);
  });

  test('keeps the old page open when controller handoff does not arrive', async () => {
    const serviceWorker = new EventTarget();
    let reloadCount = 0;
    let timeoutCount = 0;
    const worker = { postMessage: () => undefined } as ServiceWorker;

    activatePwaUpdate(worker, serviceWorker, () => reloadCount++, () => timeoutCount++, 20);

    expect(reloadCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reloadCount).toBe(0);
    expect(timeoutCount).toBe(1);
  });

  test('reloads immediately when the new worker already controls the page', () => {
    const serviceWorker = new EventTarget();
    const worker = { postMessage: () => undefined } as ServiceWorker;
    Object.defineProperty(serviceWorker, 'controller', { configurable: true, value: worker });
    let reloadCount = 0;

    activatePwaUpdate(worker, serviceWorker, () => reloadCount++, () => undefined);

    expect(reloadCount).toBe(1);
  });

  test('does nothing when the registration has no waiting worker', () => {
    let reloadCount = 0;
    activatePwaUpdate(undefined, new EventTarget(), () => reloadCount++, () => undefined);
    expect(reloadCount).toBe(0);
  });
});
