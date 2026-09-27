import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('the real update prompt waits for controller handoff and the app shell works offline', async ({ browser }) => {
  const workerSource = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
  const apiResponses: Record<string, unknown> = {
    '/v1/auth/session': {
      loggedIn: true,
      sub: 'member',
      displayName: 'Administrator',
      permissions: '1',
      identities: [],
      linkedProviders: [],
      githubOauthEnabled: false,
      discordOauthEnabled: false,
      mfa: { enabled: false, recoveryCodesRemaining: 0, required: false },
    },
    '/v1/auth/passkeys': { passkeys: [] },
    '/v1/dashboard/me/prefs': { theme: 'dark', accent: 'violet', sound: true },
    '/v1/dashboard/overview': {
      schedulerEnabled: false,
      settings: {},
      watches: [],
      devices: [],
      schedulerRunHistory: [],
      disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
      isPaidPlan: false,
      maintenance: { active: false, manual: false, auto: false },
      activeJobs: [],
    },
  };
  let build = 'release-1';
  let networkAvailable = true;
  let offlineRequestCount = 0;
  const proxy = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? '127.0.0.1'}`);

    if (url.pathname === '/sw.js') {
      outgoing.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/javascript; charset=utf-8',
      });
      outgoing.end(workerSource.replaceAll('__DKRYPT_BUILD__', build));
      return;
    }

    if (url.pathname.startsWith('/v1/')) {
      const body = apiResponses[url.pathname];
      outgoing.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify(body ?? { error: 'not mocked' }));
      return;
    }

    if (url.pathname === '/offline-check') {
      offlineRequestCount++;
      if (!networkAvailable) {
        incoming.resume();
        outgoing.destroy();
        return;
      }
    }

    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: 4173,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: '127.0.0.1:4173' },
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => {
      if (outgoing.destroyed) return;
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('PWA proxy did not bind to a TCP port');

  const context = await browser.newContext({ serviceWorkers: 'allow' });

  try {
    await context.addInitScript(() => {
      localStorage.setItem('onboardingTourSeen', 'true');
      localStorage.setItem('onboardingDismissed', 'true');

      class StableEventSource extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 2;
        readonly url: string;
        readonly withCredentials = false;
        readyState = StableEventSource.OPEN;
        onopen: ((event: Event) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string | URL) {
          super();
          this.url = String(url);
          queueMicrotask(() => this.onopen?.(new Event('open')));
        }

        close(): void {
          this.readyState = StableEventSource.CLOSED;
        }
      }

      Object.defineProperty(window, 'EventSource', { configurable: true, value: StableEventSource });
    });

    const page = await context.newPage();
    let loadEvents = 0;
    page.on('load', () => loadEvents++);
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await expect(page.getByRole('link', { name: 'Open dkrypt on GitHub' })).toBeVisible();
    await expect.poll(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return Boolean(registration?.active && navigator.serviceWorker.controller);
    })).toBe(true);
    await page.waitForTimeout(250);
    const initialDocumentTime = await page.evaluate(() => performance.timeOrigin);
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(initialDocumentTime);
    const loadEventsBeforeUpdate = loadEvents;

    build = 'release-2';
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) throw new Error('PWA service worker registration is missing');
      await registration.update();
    });

    const updateButton = page.getByRole('button', { name: 'Reload to update' });
    await expect(updateButton).toBeVisible();
    expect(loadEvents).toBe(loadEventsBeforeUpdate);
    expect(await page.evaluate(() => caches.keys())).toContain('dkrypt-shell-release-1');

    const nextPageLoad = page.waitForEvent('load', { timeout: 12_000 }).then(() => true, () => false);
    await updateButton.click();
    expect(await nextPageLoad, 'PWA update did not reload after the new worker took control').toBe(true);
    await expect(page.getByRole('button', { name: 'Reload to update' })).toHaveCount(0);
    expect(await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type)).toBe('reload');
    await expect.poll(() => page.evaluate(async () => await caches.keys())).toEqual(['dkrypt-shell-release-2']);

    networkAvailable = false;
    const offlineShell = await page.evaluate(async () => Promise.race([
      fetch('/offline-check').then(async (response) => ({ status: response.status, html: await response.text() })),
      new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 5_000)),
    ]));
    expect(offlineRequestCount).toBeGreaterThan(0);
    expect('timedOut' in offlineShell).toBe(false);
    if ('timedOut' in offlineShell) throw new Error('PWA offline fallback fetch did not settle');
    expect(offlineShell.status).toBe(200);
    expect(offlineShell.html).toContain('<div id="app-root"></div>');
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  }
});
