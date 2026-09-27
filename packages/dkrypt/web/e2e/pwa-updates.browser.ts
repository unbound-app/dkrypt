import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('a new service worker waits for the user before replacing the active version', async ({ browser }) => {
  const workerSource = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  let build = 'release-1';
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><html><head><title>dkrypt PWA update test</title></head><body>ready</body></html>');
      return;
    }
    if (pathname === '/sw.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(workerSource.replaceAll('__DKRYPT_BUILD__', build));
      return;
    }
    if (pathname === '/manifest.webmanifest') {
      response.writeHead(200, { 'content-type': 'application/manifest+json' });
      response.end('{}');
      return;
    }
    if (pathname === '/favicon.svg') {
      response.writeHead(200, { 'content-type': 'image/svg+xml' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>');
      return;
    }
    if (pathname === '/favicon.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from([]));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PWA test server did not bind to a TCP port');
  const context = await browser.newContext({ serviceWorkers: 'allow' });

  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.evaluate(async () => {
      type UpdateState = { registration?: ServiceWorkerRegistration; controllerChanges: number };
      const state = (window as unknown as { updateState: UpdateState }).updateState = { controllerChanges: 0 };
      navigator.serviceWorker.addEventListener('controllerchange', () => state.controllerChanges++);
      state.registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
      }
      state.controllerChanges = 0;
    });

    build = 'release-2';
    await page.evaluate(async () => {
      const state = (window as unknown as { updateState: { registration: ServiceWorkerRegistration } }).updateState;
      await state.registration.update();
    });

    await expect.poll(() => page.evaluate(() => {
      const state = (window as unknown as { updateState: { registration: ServiceWorkerRegistration } }).updateState;
      return state.registration.waiting?.state ?? null;
    })).toBe('installed');

    const stagedUpdate = await page.evaluate(async () => {
      const state = (window as unknown as { updateState: { registration: ServiceWorkerRegistration; controllerChanges: number } }).updateState;
      return {
        controllerChanges: state.controllerChanges,
        activeCache: (await caches.keys()).includes('dkrypt-shell-release-1'),
        waitingCache: (await caches.keys()).includes('dkrypt-shell-release-2'),
      };
    });
    expect(stagedUpdate).toEqual({ controllerChanges: 0, activeCache: true, waitingCache: true });

    await page.evaluate(() => {
      const state = (window as unknown as { updateState: { registration: ServiceWorkerRegistration } }).updateState;
      state.registration.waiting?.postMessage('skipWaiting');
    });

    await expect.poll(() => page.evaluate(() => {
      const state = (window as unknown as { updateState: { registration: ServiceWorkerRegistration; controllerChanges: number } }).updateState;
      return state.controllerChanges === 1 && state.registration.active?.state === 'activated';
    })).toBe(true);

    expect(await page.evaluate(() => caches.keys())).toEqual(['dkrypt-shell-release-2']);
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
