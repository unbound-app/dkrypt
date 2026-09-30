import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function expectAccessible(page: Page, scope?: string): Promise<void> {
  await page.locator('[data-sonner-toast]').evaluateAll(async (toasts) => {
    const animations = toasts.flatMap((toast) => toast.getAnimations({ subtree: true }))
      .filter((animation) => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
  const builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']);
  if (scope) builder.include(scope);
  const results = await builder.analyze();
  expect(results.violations.map(({ id, impact, help, nodes }) => ({
    id,
    impact,
    help,
    nodes: nodes.map(({ target, html, failureSummary }) => ({ target, html, failureSummary })),
  }))).toEqual([]);
}

async function expectVisualSnapshot(page: Page, target: Page | Locator, name: string, fullPage = false): Promise<void> {
  await page.addStyleTag({
    content: ':root, body { scrollbar-gutter: auto !important; scrollbar-width: none !important; } :root::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; } * { font-family: Arial, sans-serif !important; }',
  });
  await expect(target).toHaveScreenshot(name, {
    animations: 'disabled',
    caret: 'hide',
    fullPage,
    maxDiffPixelRatio: 0.08,
    scale: 'css',
  });
}

async function mockAuthenticatedSession(page: Page, permissions: string): Promise<void> {
  await page.unroute('**/v1/auth/session');
  await page.route('**/v1/auth/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        loggedIn: true,
        sub: 'member',
        displayName: 'Administrator',
        permissions,
        identities: [],
        linkedProviders: [],
        githubOauthEnabled: false,
        discordOauthEnabled: false,
        deployment: { ref: 'abcdef0123456789' },
        mfa: { enabled: false, recoveryCodesRemaining: 0, required: false },
      }),
    });
  });
  await page.route('**/v1/auth/passkeys', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ passkeys: [] }) });
  });
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ theme: 'dark', accent: 'violet', sound: true }) });
  });
}

async function mockAuthenticatedDashboard(page: Page, permissions: string): Promise<void> {
  await mockAuthenticatedSession(page, permissions);
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/events', async (route) => {
    await route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('onboardingTourSeen', 'true');
    localStorage.setItem('onboardingDismissed', 'true');
  });
}

async function mockVisualDashboardData(page: Page): Promise<void> {
  await page.route('**/v1/dashboard/**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        activeJobs: [],
        apps: [],
        auditLog: [],
        data: [],
        devices: [],
        entries: [],
        failurePatterns: [],
        jobs: [],
        keys: [],
        logs: [],
        members: [],
        notifications: [],
        patterns: [],
        projects: [],
        repos: [],
        roles: [],
        runs: [],
        settings: {},
        subscriptions: [],
        total: 0,
        users: [],
        watches: [],
        webhooks: [],
        workflows: [],
      }),
    });
  });
  await page.route('**/v1/billing*', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/provider-status')
      ? { providers: [], enabled: false, ready: false }
      : path.endsWith('/subscriptions')
        ? { subscriptions: [], total: 0 }
        : { enabled: false, providers: {}, plans: [], entitlement: { planId: 'viewer', decrypt: true, api: false, priority: 0 } };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function mockStableDashboardEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let visibilityState: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibilityState });
    const eventSources: Array<{ closeCount: number }> = [];
    class InstrumentedEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = InstrumentedEventSource.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private readonly record: { closeCount: number };

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        this.record = { closeCount: 0 };
        eventSources.push(this.record);
        queueMicrotask(() => this.onopen?.(new Event('open')));
      }

      close(): void {
        if (this.readyState === InstrumentedEventSource.CLOSED) return;
        this.readyState = InstrumentedEventSource.CLOSED;
        this.record.closeCount += 1;
      }
    }

    Object.defineProperty(window, 'EventSource', { configurable: true, value: InstrumentedEventSource });
    Object.assign(window, {
      __dkryptLiveTest: {
        eventSources,
        setVisibility(state: DocumentVisibilityState) {
          visibilityState = state;
          document.dispatchEvent(new Event('visibilitychange'));
        },
      },
    });
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not mocked' }),
    });
  });
  await page.route('**/v1/auth/session', async (route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'unauthorized' }),
    });
  });
});

test('status page renders an operational service and remains keyboard accessible', async ({ page }) => {
  await page.route('**/v1/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'operational',
        checkedAt: '2026-09-24T20:00:00.000Z',
        deployment: { ref: 'abcdef0123456789' },
        components: {
          service: { state: 'operational' },
          automation: { state: 'operational' },
          scheduler: { state: 'operational' },
        },
      }),
    });
  });

  await page.goto('/status');
  await expect(page.getByRole('heading', { name: 'dkrypt status' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All systems operational' })).toBeVisible();
  await expect(page.getByText('Build abcdef0', { exact: true })).toBeVisible();
  await expect(page.getByText('Device automation', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Pricing' }).first()).toHaveAttribute('href', '/pricing');

  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();

  const unnamedControls = await page.locator('button').evaluateAll((buttons) => buttons.filter((button) => !button.getAttribute('aria-label') && !button.textContent?.trim()).length);
  expect(unnamedControls).toBe(0);
  await expectAccessible(page);
});

test('pricing page fits a phone viewport without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/pricing');

  await expect(page.getByRole('heading', { name: 'Choose a dkrypt plan' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to subscribe' })).toHaveCount(4);

  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);

  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
  await expectAccessible(page);
});

test('pricing page visual layout stays consistent on desktop and mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/pricing');
  await expect(page.getByRole('heading', { name: 'Choose a dkrypt plan' })).toBeVisible();
  await expectVisualSnapshot(page, page, 'pricing-desktop.png', true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expectVisualSnapshot(page, page, 'pricing-mobile.png', true);
});

test('device overview visual layout stays consistent on desktop and mobile', async ({ page }) => {
  const device = {
    id: 'visual-device',
    name: 'Lab iPad',
    transport: 'usb',
    port: 22,
    user: 'mobile',
    udid: '00008110-001234567890001E',
    productType: 'iPad14,1',
    iosVersion: '18.0',
    enabled: true,
    isPrimary: true,
    createdAt: 1,
    updatedAt: 1,
  };

  await mockVisualDashboardData(page);
  await mockAuthenticatedSession(page, '2097152');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [device],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/events', async (route) => {
    await route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  });
  await page.route('**/v1/dashboard/devices/visual-device/health*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        reachable: true,
        screenIsOn: false,
        batteryPercent: 82,
        checkedAt: 1790604000000,
        bridgeHeartbeats: { springboard: { bridgeVersion: '1.2.0' } },
        readiness: { score: 100, state: 'ready', reasons: [] },
        subsystems: { usb: 'ready', mux: 'ready', agent: 'ready', appStore: 'ready', testFlight: 'ready', sshTunnel: 'ready' },
      }),
    });
  });
  await page.route('**/v1/dashboard/devices/visual-device/activity*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ activity: [], total: 0 }) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('onboardingTourSeen', 'true');
    localStorage.setItem('onboardingDismissed', 'true');
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?tab=settings&stab=devices');
  const deviceCard = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'Devices', exact: true }) });
  await expect(page.getByText('Lab iPad', { exact: true })).toBeVisible();
  await expectVisualSnapshot(page, deviceCard, 'devices-desktop.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await expectVisualSnapshot(page, deviceCard, 'devices-mobile.png');
});

test('IPA Library visual layout stays consistent on desktop and mobile', async ({ page }) => {
  await mockVisualDashboardData(page);
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ entries: [{ bundleId: 'com.example.visual', displayName: 'Visual App', updatedAt: 1790604000000 }] }),
    });
  });
  await page.route('**/v1/dashboard/artifacts*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        artifacts: [{
          id: 'visual-artifact',
          key: 'com.example.visual:appstore:123',
          projectIds: ['default'],
          bundleId: 'com.example.visual',
          channel: 'appstore',
          versionLabel: '2.4.0',
          buildNumber: '240',
          fileSizeBytes: 104857600,
          sha256: 'a'.repeat(64),
          createdAt: '2026-09-25T12:00:00.000Z',
          lastAccessedAt: '2026-09-25T13:00:00.000Z',
          accessCount: 3,
          sourceJobId: 'job-visual',
          warnings: [],
          fileUrl: '/v1/dashboard/artifacts/visual-artifact/file',
        }],
        total: 1,
        totalBytes: 104857600,
        maxBytes: 1048576000,
      }),
    });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  const artifactResponse = page.waitForResponse((response) => response.url().includes('/v1/dashboard/artifacts?') && response.ok());
  await page.goto('/?tab=home');
  await artifactResponse;
  const libraryCard = page.locator('[data-slot="card"]').filter({ hasText: 'IPA Library' });
  await expect(page.getByText('Visual App', { exact: true })).toBeVisible();
  await expectVisualSnapshot(page, libraryCard, 'ipa-library-desktop.png');

  await page.setViewportSize({ width: 390, height: 844 });
  await expectVisualSnapshot(page, libraryCard, 'ipa-library-mobile.png');
});

test('live updates suspend while hidden and refresh immediately when visible again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.goto('/?tab=home');

  const eventSourceCount = () => page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { eventSources: Array<{ closeCount: number }> };
  }).__dkryptLiveTest.eventSources.length);
  const eventSourceCloseCount = () => page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { eventSources: Array<{ closeCount: number }> };
  }).__dkryptLiveTest.eventSources.reduce((count, source) => count + source.closeCount, 0));

  await expect.poll(eventSourceCount).toBe(1);
  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('hidden'));
  await expect.poll(eventSourceCloseCount, { timeout: 1_000 }).toBe(1);
  await expect.poll(eventSourceCount).toBe(1);

  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('visible'));
  await expect.poll(eventSourceCount).toBe(2);

  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('hidden'));
  await expect.poll(eventSourceCloseCount).toBe(2);
  let loggedIn = true;
  await page.unroute('**/v1/auth/session');
  await page.route('**/v1/auth/session', async (route) => {
    await route.fulfill(loggedIn
      ? { contentType: 'application/json', body: JSON.stringify({ loggedIn: true, sub: 'member', displayName: 'Administrator', permissions: '1', identities: [], linkedProviders: [], githubOauthEnabled: false, discordOauthEnabled: false, deployment: { ref: 'abcdef0123456789' }, mfa: { enabled: false, recoveryCodesRemaining: 0, required: false } }) }
      : { contentType: 'application/json', body: JSON.stringify({ loggedIn: false }) });
  });
  await page.route('**/v1/auth/logout', async (route) => {
    loggedIn = false;
    await route.fulfill({ status: 204, body: '' });
  });
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('visible'));
  await expect.poll(eventSourceCount).toBe(2);
});

test('live updates keep stale data visible until a reconnect refresh succeeds', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let overviewRequests = 0;
  let releaseFailedRefresh!: () => void;
  let markFailedRefreshStarted!: () => void;
  const failedRefreshStarted = new Promise<void>((resolve) => {
    markFailedRefreshStarted = resolve;
  });
  const awaitFailedRefreshGate = new Promise<void>((resolve) => {
    releaseFailedRefresh = resolve;
  });
  const overviewPayload = {
    schedulerEnabled: false,
    settings: {},
    watches: [],
    devices: [],
    schedulerRunHistory: [],
    disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
    isPaidPlan: false,
    maintenance: { active: false, manual: false, auto: false },
    activeJobs: [],
  };
  await page.route('**/v1/dashboard/overview*', async (route) => {
    overviewRequests += 1;
    if (overviewRequests === 2) {
      markFailedRefreshStarted();
      await awaitFailedRefreshGate;
      await route.fulfill({ status: 503, body: '' });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(overviewPayload) });
  });
  await page.goto('/?tab=home');
  await expect.poll(() => overviewRequests).toBe(1);

  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('hidden'));
  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('visible'));
  await failedRefreshStarted;
  await expect(page.getByText('Reconnected - refreshing data…')).toBeVisible();

  const failedRefreshResponse = page.waitForResponse((response) => response.url().includes('/v1/dashboard/overview?') && response.status() === 503);
  releaseFailedRefresh();
  await failedRefreshResponse;
  await expect(page.getByText('Dashboard data refresh failed. Try again.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry refresh' }).click();
  await expect.poll(() => overviewRequests).toBe(3);
  await expect(page.getByText('Reconnected - refreshing data…')).toBeHidden();
});

test('live reconnect ignores overview refreshes started before suspension', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let overviewRequests = 0;
  let releaseInitialOverview!: () => void;
  let releaseReconnectedOverview!: () => void;
  let markInitialOverviewStarted!: () => void;
  let markInitialOverviewFinished!: () => void;
  let markReconnectedOverviewStarted!: () => void;
  let markReconnectedOverviewFinished!: () => void;
  const initialOverviewGate = new Promise<void>((resolve) => {
    releaseInitialOverview = resolve;
  });
  const reconnectedOverviewGate = new Promise<void>((resolve) => {
    releaseReconnectedOverview = resolve;
  });
  const initialOverviewStarted = new Promise<void>((resolve) => {
    markInitialOverviewStarted = resolve;
  });
  const initialOverviewFinished = new Promise<void>((resolve) => {
    markInitialOverviewFinished = resolve;
  });
  const reconnectedOverviewStarted = new Promise<void>((resolve) => {
    markReconnectedOverviewStarted = resolve;
  });
  const reconnectedOverviewFinished = new Promise<void>((resolve) => {
    markReconnectedOverviewFinished = resolve;
  });
  const overviewPayload = {
    schedulerEnabled: false,
    settings: {},
    watches: [],
    devices: [],
    schedulerRunHistory: [],
    disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
    isPaidPlan: false,
    maintenance: { active: false, manual: false, auto: false },
    activeJobs: [],
  };
  await page.route('**/v1/dashboard/overview*', async (route) => {
    overviewRequests += 1;
    if (overviewRequests === 1) {
      markInitialOverviewStarted();
      await initialOverviewGate;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(overviewPayload) });
      markInitialOverviewFinished();
      return;
    }
    if (overviewRequests === 2) {
      markReconnectedOverviewStarted();
      await reconnectedOverviewGate;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(overviewPayload) });
      markReconnectedOverviewFinished();
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(overviewPayload) });
  });
  await page.goto('/?tab=home');
  await initialOverviewStarted;

  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('hidden'));
  await page.evaluate(() => (window as typeof window & {
    __dkryptLiveTest: { setVisibility(state: DocumentVisibilityState): void };
  }).__dkryptLiveTest.setVisibility('visible'));
  await expect.poll(() => overviewRequests, { timeout: 1_500 }).toBe(2);
  await reconnectedOverviewStarted;
  await expect(page.getByText('Reconnected - refreshing data…')).toBeVisible();

  releaseInitialOverview();
  await initialOverviewFinished;
  await expect(page.getByText('Reconnected - refreshing data…')).toBeVisible();
  releaseReconnectedOverview();
  await reconnectedOverviewFinished;
  await expect(page.getByText('Reconnected - refreshing data…')).toBeHidden();
});

test('IPA Library filters can be saved and reapplied across reloads', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  const requestedFilters: Array<{ channel: string; query: string; archived: boolean }> = [];
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts*', async (route) => {
    const requestUrl = new URL(route.request().url());
    requestedFilters.push({
      channel: requestUrl.searchParams.get('channel') ?? 'all',
      query: requestUrl.searchParams.get('q') ?? '',
      archived: requestUrl.searchParams.get('archived') === 'true',
    });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ artifacts: [], total: 0, totalBytes: 0, maxBytes: 1024 }),
    });
  });

  await page.goto('/?tab=home');
  const search = page.getByRole('textbox', { name: 'Search apps or versions…' });
  await search.fill('com.example.saved');
  await search.press('Enter');
  await expect.poll(() => requestedFilters.at(-1)?.query).toBe('com.example.saved');
  await page.getByRole('button', { name: 'All sources' }).click();
  await page.getByRole('option', { name: 'TestFlight', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'testflight', query: 'com.example.saved', archived: false });

  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await page.getByRole('option', { name: 'Archived', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'testflight', query: 'com.example.saved', archived: true });

  await page.getByRole('textbox', { name: 'Saved filter name' }).fill('Archived TestFlight');
  await page.getByRole('button', { name: 'Save filter', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Archived TestFlight', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'TestFlight', exact: true }).click();
  await page.getByRole('option', { name: 'App Store', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'appstore', query: 'com.example.saved', archived: true });
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.getByRole('option', { name: 'Active', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'appstore', query: 'com.example.saved', archived: false });
  await page.getByRole('button', { name: 'Archived TestFlight', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'testflight', query: 'com.example.saved', archived: true });

  await page.reload();
  await expect(page.getByRole('button', { name: 'Archived TestFlight', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Archived TestFlight', exact: true }).click();
  await expect.poll(() => requestedFilters.at(-1)).toEqual({ channel: 'testflight', query: 'com.example.saved', archived: true });
  await expect(search).toHaveValue('com.example.saved');
  await expectAccessible(page);
});

test('IPA Library archive and restore keep archive state separate from eviction protection', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '8589934594');
  const artifact = {
    id: 'archive-artifact',
    key: 'com.example.archive:appstore:123',
    projectIds: ['default'],
    bundleId: 'com.example.archive',
    channel: 'appstore',
    versionLabel: '2.4.0',
    buildNumber: '240',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 1,
    fileUrl: '/v1/dashboard/artifacts/archive-artifact/file',
  };
  let artifactArchivedAt: string | undefined;
  let artifactPinnedAt: string | undefined;
  let artifactListRequestCount = 0;
  const bulkArchiveRequests: Array<{ ids: string[]; archived: boolean }> = [];
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'PUT' && url.pathname.endsWith('/archive')) {
      const payload = route.request().postDataJSON() as { archived: boolean };
      artifactArchivedAt = payload.archived ? '2026-09-26T13:00:00.000Z' : undefined;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, artifactId: artifact.id, archived: payload.archived, archivedAt: artifactArchivedAt }) });
      return;
    }
    if (route.request().method() === 'PUT' && url.pathname.endsWith('/pin')) {
      const payload = route.request().postDataJSON() as { pinned: boolean };
      artifactPinnedAt = payload.pinned ? '2026-09-26T14:00:00.000Z' : undefined;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, artifactId: artifact.id, pinned: payload.pinned, pinnedAt: artifactPinnedAt }) });
      return;
    }
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { ids: string[]; archived: boolean };
      bulkArchiveRequests.push(payload);
      artifactArchivedAt = payload.archived ? '2026-09-26T15:00:00.000Z' : undefined;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          archived: payload.archived,
          changedIds: payload.ids,
          artifacts: payload.ids.map((artifactId) => ({ artifactId, archived: payload.archived, archivedAt: artifactArchivedAt })),
        }),
      });
      return;
    }
    artifactListRequestCount += 1;
    const wantsArchived = url.searchParams.get('archived') === 'true';
    const isInCurrentView = wantsArchived === (artifactArchivedAt !== undefined);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        artifacts: isInCurrentView ? [{ ...artifact, pinnedAt: artifactPinnedAt, archivedAt: artifactArchivedAt }] : [],
        total: isInCurrentView ? 1 : 0,
        totalBytes: 1024,
        maxBytes: 10240,
      }),
    });
  });

  const artifactResponse = page.waitForResponse((response) => response.url().includes('/v1/dashboard/artifacts?') && response.ok());
  await page.goto('/?tab=home');
  await artifactResponse;
  await expect(page.locator('article').filter({ hasText: 'com.example.archive' })).toHaveCount(1);
  const listRequestsBeforeSingleArchive = artifactListRequestCount;
  await page.getByRole('button', { name: 'Archive com.example.archive' }).click();
  await expect(page.locator('article').filter({ hasText: 'com.example.archive' })).toHaveCount(0);
  await expect.poll(() => artifactListRequestCount).toBe(listRequestsBeforeSingleArchive + 1);
  await expect(page.locator('#artifact-archive-status')).toBeFocused();
  await expect(page.locator('#artifact-archive-announcement')).toHaveText('Archived com.example.archive.');

  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await page.getByRole('option', { name: 'Archived', exact: true }).click();
  const archivedArtifact = page.locator('article').filter({ hasText: 'com.example.archive' });
  await expect(archivedArtifact).toHaveCount(1);
  await expect(page.getByText('Archived items still use library storage and may be removed automatically unless pinned.')).toBeVisible();
  await archivedArtifact.getByRole('button', { name: 'Pin com.example.archive' }).click();
  await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
  await expect(archivedArtifact.getByRole('button', { name: 'Restore com.example.archive' })).toBeVisible();
  const listRequestsBeforeRestore = artifactListRequestCount;
  await archivedArtifact.getByRole('button', { name: 'Restore com.example.archive' }).click();
  await expect(page.locator('article').filter({ hasText: 'com.example.archive' })).toHaveCount(0);
  await expect.poll(() => artifactListRequestCount).toBe(listRequestsBeforeRestore + 1);
  await expect(page.locator('#artifact-archive-status')).toBeFocused();
  await expect(page.locator('#artifact-archive-announcement')).toHaveText('Restored com.example.archive.');

  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.getByRole('option', { name: 'Active', exact: true }).click();
  const activeArtifact = page.locator('article').filter({ hasText: 'com.example.archive' });
  await expect(activeArtifact).toHaveCount(1);
  await activeArtifact.getByRole('checkbox', { name: 'Select com.example.archive 2.4.0 (240)' }).check();
  const listRequestsBeforeBulkArchive = artifactListRequestCount;
  await page.getByRole('button', { name: 'Archive selected', exact: true }).click();
  await expect.poll(() => bulkArchiveRequests).toEqual([{ ids: ['archive-artifact'], archived: true }]);
  await expect(activeArtifact).toHaveCount(0);
  await expect.poll(() => artifactListRequestCount).toBe(listRequestsBeforeBulkArchive + 1);
  await expect(page.locator('#artifact-archive-status')).toBeFocused();
  await expect(page.locator('#artifact-archive-announcement')).toHaveText('Archived 1 artifact.');
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await page.getByRole('option', { name: 'Archived', exact: true }).click();
  await expect(archivedArtifact).toHaveCount(1);
  expect(artifactListRequestCount).toBeLessThan(20);
  await expectAccessible(page);
});

test('IPA Library keeps loaded artifacts visible while scrolling its rows', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let artifactListRequestCount = 0;
  const artifacts = Array.from({ length: 40 }, (_, index) => ({
    id: `scroll-artifact-${index}`,
    key: `com.example.scroll${index}:appstore:${index}`,
    projectIds: ['default'],
    bundleId: `com.example.scroll${index}`,
    channel: 'appstore' as const,
    versionLabel: '1.0.0',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 1,
    sourceJobId: `job-scroll-artifact-${index}`,
    warnings: [],
    fileUrl: `/v1/dashboard/artifacts/scroll-artifact-${index}/file`,
  }));
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts*', async (route) => {
    artifactListRequestCount += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ artifacts, total: artifacts.length, totalBytes: 40_960, maxBytes: 81_920 }),
    });
  });

  await page.goto('/?tab=home');
  const list = page.getByRole('region', { name: 'IPA library artifacts list region' });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const scrollRange = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    const artifactScrollRange = await list.evaluate((element) => element.scrollHeight - element.clientHeight);
    expect(scrollRange).toBeGreaterThan(0);
    expect(artifactScrollRange).toBe(0);
    await expect(list.locator('[data-artifact-id="scroll-artifact-0"]')).toBeVisible();
    await list.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + bounds.top + bounds.height - window.innerHeight, behavior: 'instant' });
    });
    const finalArtifact = list.locator('[data-artifact-id="scroll-artifact-39"]');
    await expect(finalArtifact).toBeAttached();
    await finalArtifact.scrollIntoViewIfNeeded();
    await expect(finalArtifact).toBeInViewport();
    await list.evaluate((element) => window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - 80, behavior: 'instant' }));
    await expect(list.locator('[data-artifact-id="scroll-artifact-0"]')).toBeInViewport();
  }
  await expect.poll(() => artifactListRequestCount).toBe(1);
});

test('IPA Library stays populated and does not refetch loaded results during incremental scrolling', async ({ page }) => {
  test.setTimeout(60_000);
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let artifactListRequestCount = 0;
  const warning = 'Payload/Example.app/Extensions/Share.appex/Share still encrypted (cryptid != 0)';
  const artifacts = Array.from({ length: 120 }, (_, index) => ({
    id: `wheel-scroll-artifact-${index}`,
    key: `com.example.wheel${index}:appstore:${index}`,
    projectIds: ['default'],
    bundleId: `com.example.wheel${index}`,
    channel: 'appstore' as const,
    versionLabel: '1.0.0',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 1,
    sourceJobId: `job-wheel-scroll-artifact-${index}`,
    warnings: index === 0 ? [warning] : [],
    fileUrl: `/v1/dashboard/artifacts/wheel-scroll-artifact-${index}/file`,
  }));
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts*', async (route) => {
    artifactListRequestCount += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ artifacts, total: artifacts.length, totalBytes: 122_880, maxBytes: 245_760 }),
    });
  });

  const artifactResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/v1/dashboard/artifacts' && response.ok(),
  );
  await page.goto('/?tab=home');
  await artifactResponse;
  const viewport = page.getByRole('region', { name: 'IPA library artifacts list region' });
  const viewportHandle = await viewport.elementHandle();
  if (!viewportHandle) throw new Error('IPA Library artifacts viewport did not mount');
  const firstArtifact = viewport.locator('[data-artifact-id="wheel-scroll-artifact-0"]');
  await expect(viewport.locator('[role="listitem"]').first()).toHaveAttribute('aria-setsize', '120');
  await expect.poll(() => viewport.locator('[role="listitem"]').count()).toBeLessThan(120);

  await page.setViewportSize({ width: 390, height: 844 });
  await firstArtifact.scrollIntoViewIfNeeded();
  await expect(firstArtifact).toBeVisible();
  const details = firstArtifact.locator('summary').filter({ hasText: 'Artifact details' });
  if (!(await firstArtifact.locator('details').evaluate((element) => element.open))) await details.click();
  await expect(firstArtifact.getByText(warning, { exact: true })).toBeVisible();
  await viewportHandle.evaluate((element) => {
    const samples: Array<{ kind: 'blank' | 'detached'; scrollY: number; renderedRows: number }> = [];
    const browserWindow = window as typeof window & { __ipaLibraryScrollSamples?: typeof samples };
    browserWindow.__ipaLibraryScrollSamples = samples;
    const sample = () => {
      const region = element.getBoundingClientRect();
      const regionVisible = region.bottom > 0 && region.top < window.innerHeight;
      const rows = Array.from(element.querySelectorAll<HTMLElement>('[role="listitem"]'));
      const hasVisibleRow = rows.some((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > Math.max(region.top, 0) && bounds.top < Math.min(region.bottom, window.innerHeight);
      });
      if (!element.isConnected) samples.push({ kind: 'detached', scrollY: window.scrollY, renderedRows: rows.length });
      else if (regionVisible && !hasVisibleRow) samples.push({ kind: 'blank', scrollY: window.scrollY, renderedRows: rows.length });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const firstArtifactBounds = await firstArtifact.boundingBox();
  if (!firstArtifactBounds) throw new Error('First IPA Library artifact is not visible');
  await page.mouse.move(firstArtifactBounds.x + firstArtifactBounds.width / 2, firstArtifactBounds.y + firstArtifactBounds.height / 2);
  const scrollYBeforeWheel = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 360);
  await page.waitForTimeout(32);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrollYBeforeWheel);
  for (const direction of [1, -1]) {
    let enteredLibrary = false;
    let checkedPositions = 0;
    for (let step = 0; step < 30; step += 1) {
      await page.mouse.wheel(0, direction * 800);
      await page.waitForTimeout(16);
      const sample = await viewportHandle.evaluate((element) => {
        const region = element.getBoundingClientRect();
        const regionVisible = region.bottom > 0 && region.top < window.innerHeight;
        if (!regionVisible) return { attached: element.isConnected, label: element.getAttribute('aria-label'), regionVisible, hasVisibleRow: true };
        const visibleTop = Math.max(region.top, 0);
        const visibleBottom = Math.min(region.bottom, window.innerHeight);
        const hasVisibleRow = Array.from(element.querySelectorAll<HTMLElement>('[role="listitem"]')).some((row) => {
          const bounds = row.getBoundingClientRect();
          return bounds.bottom > visibleTop && bounds.top < visibleBottom;
        });
        return { attached: element.isConnected, label: element.getAttribute('aria-label'), regionVisible, hasVisibleRow };
      });
      if (!sample.attached || sample.label !== 'IPA library artifacts list region') {
        const pageState = await page.locator('body').evaluate((element) => ({
          regions: Array.from(element.querySelectorAll<HTMLElement>('[role="region"]')).map((region) => ({
            label: region.getAttribute('aria-label'),
            visible: region.getBoundingClientRect().bottom > 0 && region.getBoundingClientRect().top < window.innerHeight,
          })),
          artifactRows: element.querySelectorAll('[data-artifact-id]').length,
          text: element.innerText.slice(0, 1200),
        }));
        throw new Error(`IPA Library viewport changed during scroll at direction ${direction}, step ${step}: ${JSON.stringify({ sample, artifactListRequestCount, pageState })}`);
      }
      if (sample.regionVisible) {
        enteredLibrary = true;
        checkedPositions += 1;
        expect(sample.hasVisibleRow).toBe(true);
      } else if (enteredLibrary) {
        break;
      }
    }
    expect(checkedPositions).toBeGreaterThan(0);
  }

  await firstArtifact.scrollIntoViewIfNeeded();
  await expect(firstArtifact).toBeAttached();
  await expect(firstArtifact.getByText('com.example.wheel0', { exact: true }).first()).toBeVisible();
  const scrollSamples = await page.evaluate(() => (window as typeof window & {
    __ipaLibraryScrollSamples?: Array<{ kind: 'blank' | 'detached'; scrollY: number; renderedRows: number }>;
  }).__ipaLibraryScrollSamples ?? []);
  expect(scrollSamples).toEqual([]);
  await expect.poll(() => artifactListRequestCount).toBe(1);
  expect(await viewport.locator('[role="listitem"]').count()).toBeLessThan(120);
  await expect(viewport.locator('[role="listitem"]').first()).toHaveAttribute('aria-setsize', '120');
  expect(runtimeErrors.filter((message) => message.includes('effect_update_depth_exceeded'))).toEqual([]);
});

test('IPA Library discards a page response from a source filter that is no longer active', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let beginOldPage!: () => void;
  let releaseOldPage!: () => void;
  const oldPageStarted = new Promise<void>((resolve) => {
    beginOldPage = resolve;
  });
  const oldPageGate = new Promise<void>((resolve) => {
    releaseOldPage = resolve;
  });
  const artifact = (id: string, bundleId: string, channel: 'appstore' | 'testflight') => ({
    id,
    key: `${bundleId}:${channel}:${id}`,
    projectIds: ['default'],
    bundleId,
    channel,
    versionLabel: '1.0.0',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 1,
    sourceJobId: `job-${id}`,
    warnings: [],
    fileUrl: `/v1/dashboard/artifacts/${id}/file`,
  });
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts*', async (route) => {
    const requestUrl = new URL(route.request().url());
    const channel = requestUrl.searchParams.get('channel');
    if (requestUrl.searchParams.get('cursor') === 'appstore-older') {
      beginOldPage();
      await oldPageGate;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ artifacts: [artifact('old-appstore', 'com.example.old-page', 'appstore')], total: 2, totalBytes: 2048, maxBytes: 4096 }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(channel === 'testflight'
        ? { artifacts: [artifact('current-testflight', 'com.example.current-testflight', 'testflight')], total: 1, totalBytes: 1024, maxBytes: 4096 }
        : { artifacts: [artifact('initial-appstore', 'com.example.initial', 'appstore')], total: 2, totalBytes: 2048, maxBytes: 4096, nextCursor: 'appstore-older' }),
    });
  });

  const initialArtifactResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/v1/dashboard/artifacts' && response.ok(),
  );
  await page.goto('/?tab=home');
  await initialArtifactResponse;
  await expect(page.locator('[data-artifact-id="initial-appstore"]')).toHaveCount(1);
  await page.getByRole('button', { name: /Load more/ }).click();
  await oldPageStarted;
  await page.getByRole('button', { name: 'All sources' }).click();
  await page.getByRole('option', { name: 'TestFlight', exact: true }).click();
  await expect(page.locator('[data-artifact-id="current-testflight"]')).toHaveCount(1);
  releaseOldPage();
  await expect(page.locator('[data-artifact-id="old-appstore"]')).toHaveCount(0);
});

test('date and number format preference is saved and restored from the account', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  const preferenceUpdates: Array<Record<string, unknown>> = [];
  let savedFormattingLocale = 'en';
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ formattingLocale: savedFormattingLocale, theme: 'dark', accent: 'violet', sound: true }),
      });
      return;
    }
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    preferenceUpdates.push(patch);
    if (typeof patch.formattingLocale === 'string') savedFormattingLocale = patch.formattingLocale;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ formattingLocale: savedFormattingLocale }) });
  });
  await page.route('**/v1/billing', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        provider: 'stripe',
        environment: 'live',
        managedPayments: true,
        missingConfiguration: [],
        plans: [{ id: 'regular', name: 'Regular', description: 'Standard access', amount: 5, currency: 'EUR', priceId: 'price_regular' }],
        legacyBilling: false,
        entitlement: { planId: 'viewer', decrypt: true, api: false, priority: 0 },
        providers: {
          stripe: { enabled: true, ready: true, environment: 'live' },
          crypto: { enabled: false, ready: false, environment: 'live', provider: 'nowpayments', assets: [] },
        },
      }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  const locale = page.getByLabel('Date and number format');
  await expect(locale).toHaveValue('en');
  await locale.selectOption('de');

  await expect.poll(() => preferenceUpdates).toEqual([{ formattingLocale: 'de' }]);
  await page.keyboard.press('Escape');
  const expectedPrice = await page.evaluate(() => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(5));
  await page.getByRole('button', { name: 'Plans', exact: true }).click();
  await expect(page.getByText(expectedPrice, { exact: true })).toBeVisible();

  await page.evaluate(() => localStorage.removeItem('formattingLocale'));
  await page.reload();
  await page.getByRole('button', { name: 'Plans', exact: true }).click();
  await expect(page.getByText(expectedPrice, { exact: true })).toBeVisible();

  const checkedAt = '2026-09-27T00:30:00.000Z';
  await page.route('**/v1/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'operational',
        checkedAt,
        deployment: { ref: 'abcdef0123456789' },
        components: {
          service: { state: 'operational' },
          automation: { state: 'operational' },
          scheduler: { state: 'operational' },
        },
      }),
    });
  });
  await page.goto('/status');
  const expectedCheckedAt = await page.evaluate((value) => new Intl.DateTimeFormat('de-DE', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value)), checkedAt);
  await expect(page.getByText(expectedCheckedAt, { exact: false })).toBeVisible();
});

test('automatic date formatting follows system language changes', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US'] });
  });
  const checkedAt = '2026-09-27T00:30:00.000Z';
  await page.route('**/v1/status', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'operational',
        checkedAt,
        deployment: { ref: 'abcdef0123456789' },
        components: {
          service: { state: 'operational' },
          automation: { state: 'operational' },
          scheduler: { state: 'operational' },
        },
      }),
    });
  });

  await page.goto('/status');
  const formatCheckedAt = (locale: string) => page.evaluate((input) => new Intl.DateTimeFormat(input.locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(input.checkedAt)), { locale, checkedAt });
  const englishCheckedAt = await formatCheckedAt('en-US');
  const germanCheckedAt = await formatCheckedAt('de-DE');
  await expect(page.getByText(englishCheckedAt, { exact: false })).toBeVisible();

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, value: ['de-DE'] });
    window.dispatchEvent(new Event('languagechange'));
  });

  await expect(page.getByText(germanCheckedAt, { exact: false })).toBeVisible();
  await expect(page.getByText(englishCheckedAt, { exact: false })).not.toBeVisible();
});

test('accounts without a saved format preference do not inherit the previous browser choice', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('formattingLocale', 'de'));
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');

  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();

  await expect(page.getByLabel('Date and number format')).toHaveValue('system');
});

test('active jobs table supports keyboard scrolling on constrained viewports', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 812 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [{
          id: 'job-keyboard-scroll',
          bundleId: 'com.example.keyboard-scroll',
          source: 'App Store',
          status: 'queued',
          progress: 'Waiting for a device',
          createdAt: '2026-09-27T00:00:00.000Z',
          priority: 0,
          queuedBy: 'member',
          versionLabel: '1.0',
        }],
      }),
    });
  });

  await page.goto('/');

  const region = page.getByRole('region', { name: 'Active jobs table scroll area' });
  await expect(region).toBeVisible();
  await region.scrollIntoViewIfNeeded();
  await expect.poll(() => region.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await region.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.keyboard.press('End');
  await expect.poll(() => region.evaluate((element) => element.scrollLeft === element.scrollWidth - element.clientWidth)).toBe(true);
  await page.keyboard.press('Home');
  await expect.poll(() => region.evaluate((element) => element.scrollLeft)).toBe(0);
});

test('automation managers can inspect queue objective breaches in Insights', async ({ page }) => {
  await page.clock.install();
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '4294967296');
  await page.route('**/v1/dashboard/insights*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        totalRuns: 0,
        doneCount: 0,
        failedCount: 0,
        successRate: 0,
        totalSizeBytes: 0,
        manualCount: 0,
        schedulerCount: 0,
        topApps: [],
        trend: [],
        failureBreakdown: [],
        byDevice: [],
        anomalies: [],
      }),
    });
  });
  let sloRequests = 0;
  let elapsedBreach = false;
  await page.route('**/v1/dashboard/jobs/slo*', async (route) => {
    sloRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        targetMs: 300_000,
        historicalP95Ms: 120_000,
        jobs: [{
          id: 'job-slo-1',
          bundleId: 'com.example.slo',
          status: 'queued',
          waitedMs: elapsedBreach ? 301_000 : 70_000,
          predictedStartMs: elapsedBreach ? null : 120_000,
          predictedCompletionMs: elapsedBreach ? null : 240_000,
          parallelism: 2,
          objective: 'breached',
        }],
      }),
    });
  });
  await page.route('**/v1/dashboard/failure-patterns*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ patterns: [] }) });
  });
  await page.route('**/v1/dashboard/storage-forecast*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ freeBytes: 0, bytesPerDay: 0, daysRemaining: null, sampleCount: 0 }) });
  });
  await page.route('**/v1/dashboard/watches/health*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ watches: [] }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Insights', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Queue objective' })).toBeVisible();
  await expect(page.getByText('Projected late', { exact: true })).toBeVisible();
  await expect(page.getByText(/best-case total/)).toBeVisible();
  const initialRequests = sloRequests;
  elapsedBreach = true;
  await page.clock.fastForward(30_000);
  await expect.poll(() => sloRequests).toBeGreaterThan(initialRequests);
  await expect(page.getByText('Objective missed', { exact: true })).toBeVisible();
});

test('queue objective details stay hidden from members without automation access', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  let sloRequests = 0;
  await page.route('**/v1/dashboard/jobs/slo*', async (route) => {
    sloRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ targetMs: 300_000, historicalP95Ms: null, jobs: [] }) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Insights', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Queue objective' })).toHaveCount(0);
  expect(sloRequests).toBe(0);
});

test('batch TestFlight queue selects an eligible device independently for each app', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  await page.route('**/v1/billing', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ providers: { stripe: { enabled: false }, crypto: { enabled: false } } }),
    });
  });
  const verifiedAt = Date.now();
  await page.route('**/v1/dashboard/testflight/catalog*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        apps: [
          {
            appId: 12345,
            bundleId: 'com.example.testflight',
            displayName: 'Example Beta',
            devices: [
              { id: 'device-1', name: 'Test iPad', verifiedAt },
              { id: 'device-2', name: 'Alternate iPad', verifiedAt },
            ],
            lastVerifiedAt: verifiedAt,
            deviceSource: true,
          },
          {
            appId: 54321,
            bundleId: 'com.example.other',
            displayName: 'Other Beta',
            devices: [{ id: 'device-3', name: 'Third iPad', verifiedAt }],
            lastVerifiedAt: verifiedAt,
            deviceSource: true,
          },
        ],
        fetchedAt: Date.now(),
      }),
    });
  });
  await page.route('**/v1/dashboard/testflight/*/trains*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ trains: [{ trainVersion: '2.4.1', buildCount: 1 }] }) });
  });
  await page.route('**/v1/dashboard/testflight/*/builds*', async (route) => {
    const appId = Number(new URL(route.request().url()).pathname.split('/').at(-2));
    const bundleId = appId === 12345 ? 'com.example.testflight' : 'com.example.other';
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ builds: [{ id: appId, bundleId, cfBundleShortVersion: '2.4.1', cfBundleVersion: '123' }] }),
    });
  });
  const queuedRequests: Record<string, unknown>[] = [];
  await page.route('**/v1/dashboard/testflight/decrypt', async (route) => {
    queuedRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ id: `job-testflight-batch-${queuedRequests.length}`, status: 'queued', progress: 'Queued', queue: { position: queuedRequests.length, total: 2 } }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Batch decrypt' }).first().click();
  await page.getByRole('button', { name: 'TestFlight', exact: true }).click();
  await page.getByPlaceholder('com.example.app@2.4.1_123\ncom.example.app2@3.0_456').fill('com.example.testflight@2.4.1_123\ncom.example.other@2.4.1_123');
  const eligibleDevice = page.getByRole('button', { name: 'Eligible device for Example Beta' });
  await expect(eligibleDevice).toBeVisible();
  await eligibleDevice.click();
  await page.getByRole('option', { name: 'Alternate iPad' }).click();
  await expect(page.getByText('Third iPad', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Queue all' }).click();

  await expect.poll(() => queuedRequests).toHaveLength(2);
  expect(queuedRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({
      bundleId: 'com.example.testflight',
      appId: 12345,
      deviceId: 'device-2',
      build: expect.objectContaining({ id: 12345, cfBundleShortVersion: '2.4.1', cfBundleVersion: '123' }),
    }),
    expect.objectContaining({
      bundleId: 'com.example.other',
      appId: 54321,
      deviceId: 'device-3',
      build: expect.objectContaining({ id: 54321, cfBundleShortVersion: '2.4.1', cfBundleVersion: '123' }),
    }),
  ]));
  await expect(page.getByText('com.example.testflight@2.4.1_123', { exact: true })).toBeVisible();
  await expect(page.getByText('Queued 2 of 2', { exact: true })).toBeHidden({ timeout: 10_000 });
  await expectAccessible(page);
});

test('batch queue retries only failed entries after a partial success', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  await page.route('**/v1/billing', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ providers: { stripe: { enabled: false }, crypto: { enabled: false } } }),
    });
  });
  const attempts: string[] = [];
  await page.route('**/v1/dashboard/decrypt', async (route) => {
    const body = route.request().postDataJSON() as { bundleId: string };
    attempts.push(body.bundleId);
    if (body.bundleId === 'com.example.retry' && attempts.filter((bundleId) => bundleId === body.bundleId).length === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'temporarily unavailable' }) });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ id: `job-${body.bundleId}`, status: 'queued', progress: 'Queued', queue: { position: 1, total: 1 } }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Batch decrypt' }).first().click();
  await page.getByPlaceholder('com.example.app\ncom.example.app2@version_123').fill('com.example.retry\ncom.example.success');
  await page.getByRole('button', { name: 'Queue all' }).click();
  await expect(page.getByRole('button', { name: 'Retry 1 failed' })).toBeVisible();
  expect(attempts).toEqual(['com.example.retry', 'com.example.success']);

  await page.getByRole('button', { name: 'Retry 1 failed' }).click();
  await expect.poll(() => attempts).toEqual(['com.example.retry', 'com.example.success', 'com.example.retry']);
  await expect(page.getByTitle('com.example.success@')).toBeVisible();
  await expect(page.getByText('Queued 1 of 1', { exact: true })).toBeHidden({ timeout: 10_000 });
  await expectAccessible(page);
});

test('batch queue exports each result and error as a CSV download', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  const attempts: string[] = [];
  await page.route('**/v1/dashboard/decrypt', async (route) => {
    const body = route.request().postDataJSON() as { bundleId: string };
    attempts.push(body.bundleId);
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'job-com.example.success', status: 'queued', progress: 'Queued', queue: { position: 1, total: 1 } }),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Batch decrypt' }).first().click();
  await page.getByPlaceholder('com.example.app\ncom.example.app2@version_123').fill('com.example.fail@bad"id\ncom.example.formula@=1+1\ncom.example.success@version_2');
  await page.getByRole('button', { name: 'Queue all' }).click();
  await expect(page.getByRole('button', { name: 'Retry 2 failed' })).toBeVisible();
  await expect(page.getByText('Queued 1 of 2', { exact: true })).toBeHidden({ timeout: 10_000 });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export results' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('dkrypt-batch-results.csv');
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  expect(await readFile(downloadPath!, 'utf8')).toBe([
    '"bundle_id","selector","status","job_id","error"',
    '"com.example.fail","bad""id","failed","","invalid App Store version ID"',
    '"com.example.formula","\'=1+1","failed","","invalid App Store version ID"',
    '"com.example.success","version_2","queued","job-com.example.success",""',
  ].join('\r\n') + '\r\n');
  expect(attempts).toEqual(['com.example.success']);
  await expectAccessible(page);
});

test('pricing plan checkout actions share a bottom baseline', async ({ page }) => {
  for (const width of [1264, 1280, 1365, 1440, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/pricing');

    const buttons = page.getByRole('link', { name: 'Sign in to subscribe' });
    const paymentDetails = page.getByText('Stripe or crypto checkout', { exact: true });
    await expect(buttons).toHaveCount(4);
    await expect(paymentDetails).toHaveCount(4);
    const cardLayout = await page.locator('main > div.grid > [data-slot="card"]').evaluateAll((cards) => cards.map((card) => {
      const rect = card.getBoundingClientRect();
      const button = card.querySelector('a[href="/#sign-in"]');
      const price = card.querySelector('.text-3xl');
      const paymentDetails = [...card.querySelectorAll('div')].find((element) => element.textContent?.trim() === 'Stripe or crypto checkout');
      return {
        top: rect.top,
        buttonBottom: button?.getBoundingClientRect().bottom ?? Number.NaN,
        buttonWidth: button?.getBoundingClientRect().width ?? Number.NaN,
        priceTop: price?.getBoundingClientRect().top ?? Number.NaN,
        paymentDetailsTop: paymentDetails?.getBoundingClientRect().top ?? Number.NaN,
        paymentDetailsWidth: paymentDetails?.getBoundingClientRect().width ?? Number.NaN,
      };
    }));
    const rows = new Map<number, typeof cardLayout>();
    for (const card of cardLayout) {
      const rowTop = [...rows.keys()].find((top) => Math.abs(top - card.top) <= 2) ?? card.top;
      rows.set(rowTop, [...(rows.get(rowTop) ?? []), card]);
    }
    for (const row of rows.values()) {
      for (const key of ['buttonBottom', 'priceTop', 'paymentDetailsTop'] as const) {
        const positions = row.map((card) => card[key]);
        expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(2);
      }
      expect(row.every((card) => Math.abs(card.buttonWidth - card.paymentDetailsWidth) <= 2)).toBe(true);
    }
  }
});

test('scheduler watch time zone selection is searchable and defaults to the browser zone', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');

  await page.goto('/?tab=settings&stab=scheduler');
  await page.getByRole('button', { name: 'Add watch', exact: true }).click();

  const timezone = page.getByRole('combobox', { name: 'Schedule time zone' });
  const browserTimezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect(timezone).toHaveValue(browserTimezone);
  await timezone.fill('Europe/Berlin');
  await page.getByRole('option', { name: 'Europe/Berlin', exact: true }).click();
  await expect(timezone).toHaveValue('Europe/Berlin');
  await page.getByRole('button', { name: 'Hourly · quiet 22–06' }).click();
  await expect(page.locator('#w-maintenance-start')).toHaveValue('22:00');
  await expect(page.locator('#w-maintenance-end')).toHaveValue('06:00');
  const missedRunPolicy = page.getByRole('button', { name: 'Missed checks' });
  await expect(missedRunPolicy).toContainText('Skip missed checks');
  await missedRunPolicy.click();
  await page.getByRole('option', { name: 'Run one check after restart' }).click();
  await expect(missedRunPolicy).toContainText('Run one check after restart');
  await expectAccessible(page);
});

test('scheduler calendar preview labels checks deferred by quiet hours', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('formattingLocale', 'de'));
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ formattingLocale: 'de', theme: 'dark', accent: 'violet' }) });
  });
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [{ id: 'watch-quiet', bundleId: 'com.example.quiet', repo: 'example/repo', ghWorkflowFile: 'dispatch.yml', pollCron: '0 * * * *', timezone: 'America/Los_Angeles', enabled: true, createdAt: 1, updatedAt: 1, schedulable: true, configIssues: [] }],
        devices: [],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [],
      }),
    });
  });
  const scheduledAt = Date.parse('2026-10-25T09:00:00.000Z');
  await page.route('**/v1/dashboard/watches/calendar*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        fromAt: Date.parse('2026-10-25T08:00:00.000Z'),
        untilAt: Date.parse('2026-10-26T08:00:00.000Z'),
        runs: [{ watchId: 'watch-quiet', bundleId: 'com.example.quiet', at: scheduledAt, deferred: true }],
        truncated: false,
      }),
    });
  });

  await page.goto('/?tab=settings&stab=scheduler');
  await page.getByRole('button', { name: 'Preview next 24 hours' }).click();
  await expect(page.getByRole('heading', { name: 'Next 24 hours' })).toBeVisible();
  await expect(page.getByText('After quiet hours')).toBeVisible();
  await expect(page.getByText('com.example.quiet').first()).toBeVisible();
  const expectedScheduleTime = await page.evaluate((at) => new Intl.DateTimeFormat('de-DE', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  }).format(new Date(at)), scheduledAt);
  await expect(page.getByRole('main').locator('time')).toContainText(`${expectedScheduleTime} · America/Los_Angeles`);
  await expectAccessible(page, 'main div.max-h-64.divide-border');
});

test('self-hosters can review configuration doctor checks from Settings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(pathname === '/v1/billing' ? { providers: { stripe: { enabled: false }, crypto: { enabled: false } } } : {}),
    });
  });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  let doctorRequests = 0;
  await page.route('**/v1/dashboard/doctor', async (route) => {
    doctorRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: doctorRequests > 1,
        checkedAt: '2026-09-27T12:00:00.000Z',
        checks: doctorRequests > 1 ? [
          { id: 'database', status: 'ok', detail: 'SQLite schema 12 is intact' },
        ] : [
          { id: 'database', status: 'ok', detail: 'SQLite schema 12 is intact' },
          { id: 'session-secret-rotation', status: 'warn', detail: 'No overlapping previous credential is configured' },
          { id: 'device-bridge', status: 'error', detail: 'Rust device bridge socket is not available yet' },
        ],
        deployment: { id: 'run-doctor-1', ref: 'abcdef0123456789' },
      }),
    });
  });

  await page.goto('/?tab=settings&stab=doctor');

  await expect(page.getByRole('heading', { name: 'System doctor' })).toBeVisible();
  await expect(page.getByText('run-doctor-1')).toBeVisible();
  await expect(page.getByText('abcdef0123456789')).toBeVisible();
  await expect(page.getByText('Configuration needs attention')).toBeVisible();
  await expect(page.getByText('SQLite schema 12 is intact')).toBeVisible();
  await expect(page.getByText('Rust device bridge socket is not available yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh checks' })).toBeVisible();
  expect(doctorRequests).toBe(1);
  await page.getByRole('button', { name: 'Refresh checks' }).click();
  await expect(page.getByText('All checks passed')).toBeVisible();
  expect(doctorRequests).toBe(2);
  const dimensions = await page.evaluate(() => ({ bodyWidth: document.body.scrollWidth, viewportWidth: document.documentElement.clientWidth }));
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  await expectAccessible(page);
});

test('system doctor is hidden from accounts without device-management permission', async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(pathname === '/v1/billing' ? { providers: { stripe: { enabled: false }, crypto: { enabled: false } } } : {}),
    });
  });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2097152');
  let doctorRequests = 0;
  await page.route('**/v1/dashboard/doctor', async (route) => {
    doctorRequests += 1;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, checkedAt: '2026-09-27T12:00:00.000Z', deployment: { id: 'run-device-1', ref: 'abcdef0123456789' }, checks: [] }) });
  });

  await page.goto('/?tab=settings&stab=doctor');

  await expect(page.getByRole('tab', { name: 'Devices' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'System' })).toHaveCount(0);
  expect(doctorRequests).toBe(0);
});

test('device managers can run on-demand service health checks', async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(pathname === '/v1/billing' ? { providers: { stripe: { enabled: false }, crypto: { enabled: false } } } : {}),
    });
  });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/doctor', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, checkedAt: '2026-09-27T12:00:00.000Z', deployment: { id: 'run-device-2', ref: 'abcdef0123456789' }, checks: [] }) });
  });
  let probeRequests = 0;
  await page.route('**/v1/dashboard/synthetic', async (route) => {
    probeRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        checkedAt: '2026-09-27T12:01:00.000Z',
        probes: [
          { id: 'database', status: 'ok', durationMs: 14, detail: 'SQLite integrity is clean' },
          { id: 'device-agent', status: 'error', durationMs: 340, detail: 'The device agent did not respond' },
        ],
      }),
    });
  });

  await page.goto('/?tab=settings&stab=doctor');
  await expect(page.getByRole('heading', { name: 'System doctor' })).toBeVisible();
  await expect(page.getByText('TestFlight uses its last device verification and is never opened or refreshed.')).toBeVisible();
  expect(probeRequests).toBe(0);
  await page.getByRole('button', { name: 'Run health checks' }).click();

  await expect(page.getByText('Service health checks')).toBeVisible();
  await expect(page.getByText('SQLite integrity is clean')).toBeVisible();
  await expect(page.getByText('The device agent did not respond')).toBeVisible();
  expect(probeRequests).toBe(1);
  await expectAccessible(page);
});

test('authenticated top bar exposes community links without mobile overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAuthenticatedDashboard(page, '1');

  await page.goto('/');
  const github = page.getByRole('link', { name: 'Open dkrypt on GitHub' });
  const discord = page.getByRole('link', { name: 'Join the dkrypt Discord server' });
  await expect(github).toBeVisible();
  await expect(discord).toBeVisible();
  await expect(github).toHaveAttribute('href', 'https://github.com/unbound-app/dkrypt');
  await expect(discord).toHaveAttribute('href', 'https://discord.gg/NdaBaxFKnn');
  await expect(discord).toHaveAttribute('target', '_blank');

  const dimensions = await page.evaluate(() => ({ bodyWidth: document.body.scrollWidth, viewportWidth: document.documentElement.clientWidth }));
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  await expectAccessible(page, 'header.glass-topbar');
});

test('authenticated dashboard shows the running build revision', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');

  await page.goto('/');

  await expect(page.getByText('Build abcdef0', { exact: true })).toBeVisible();
});

test('API documentation embeds Scalar in the Docs tab with a new-tab fallback', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  await page.context().route(/\/reference\/?$/, async (route) => {
    await route.fulfill({
      headers: { 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" },
      contentType: 'text/html',
      body: '<!doctype html><html><body><h1>API reference is ready</h1></body></html>',
    });
  });

  await page.goto('/?tab=docs');
  const reference = page.frameLocator('iframe[title="dkrypt API reference"]');
  const referenceLink = page.getByRole('link', { name: 'Open API reference in new tab' });

  await expect(page.locator('iframe[title="dkrypt API reference"]')).toBeVisible();
  await expect(page.locator('iframe[title="dkrypt API reference"]')).toHaveAttribute('src', '/reference/');
  await expect(referenceLink).toHaveAttribute('href', '/reference/');
  await expect(referenceLink).toHaveAttribute('target', '_blank');
  await expect(reference.getByRole('heading', { name: 'API reference is ready' })).toBeVisible();
});

test('interface language localizes the account menu and persists to the account', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '2');
  await page.unroute('**/v1/dashboard/me/prefs');

  const savedPrefs = { theme: 'dark', accent: 'violet', sound: true };
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    if (route.request().method() === 'PUT') {
      Object.assign(savedPrefs, route.request().postDataJSON());
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(savedPrefs),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.locator('#interface-language').selectOption('de');

  await expect(page.getByRole('button', { name: 'Startseite', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kontomenü' })).toBeVisible();
  await expect(page.getByText('Anmeldeverbindungen')).toBeVisible();
  await expect(page.getByText('Eigene Entschlüsselungsaufträge beantragen und verwalten')).toBeVisible();
  await expect(page.getByText('Noch keine Passkeys registriert.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sitzungen verwalten' })).toBeVisible();
  await expect(page.locator('#interface-language option[value="en"]')).toHaveText('Englisch');
  await expect(page.locator('.account-menu')).toHaveAttribute('lang', 'de');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect.poll(() => savedPrefs.interfaceLanguage).toBe('de');

  await page.reload();
  await page.getByRole('button', { name: 'Kontomenü' }).click();
  await expect(page.getByText('Sitzungen verwalten')).toBeVisible();
});

test('high contrast preference updates the interface and persists to the account', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  await page.unroute('**/v1/dashboard/me/prefs');

  const savedPrefs = { theme: 'dark', accent: 'violet', sound: true, highContrast: false };
  await page.route('**/v1/dashboard/me/prefs', async (route) => {
    if (route.request().method() === 'PUT') {
      Object.assign(savedPrefs, route.request().postDataJSON());
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(savedPrefs),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Account menu' }).click();
  const highContrastToggle = page.getByRole('button', { name: 'High contrast mode' });
  await expect(highContrastToggle).toHaveAttribute('aria-pressed', 'false');
  await highContrastToggle.click();

  await expect(highContrastToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-high-contrast', 'true');
  await expect.poll(() => savedPrefs.highContrast).toBe(true);

  const measureContrastRatios = () => page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const luminance = (hex: string) => {
      const raw = hex.trim().replace('#', '');
      const normalized = raw.length === 3 ? [...raw].map((channel) => channel + channel).join('') : raw;
      const channels = [0, 2, 4].map((index) => parseInt(normalized.slice(index, index + 2), 16) / 255);
      const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
    };
    const contrast = (first: string, second: string) => {
      const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
      return (lighter + 0.05) / (darker + 0.05);
    };
    return {
      text: contrast(style.getPropertyValue('--foreground').trim(), style.getPropertyValue('--background').trim()),
      accent: contrast(style.getPropertyValue('--color-accent').trim(), style.getPropertyValue('--background').trim()),
    };
  });
  const darkContrast = await measureContrastRatios();
  expect(darkContrast.text).toBeGreaterThanOrEqual(7);
  expect(darkContrast.accent).toBeGreaterThanOrEqual(7);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Theme: dark (click to cycle)' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const lightContrast = await measureContrastRatios();
  expect(lightContrast.text).toBeGreaterThanOrEqual(7);
  expect(lightContrast.accent).toBeGreaterThanOrEqual(7);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-high-contrast', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'High contrast mode' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-high-contrast', 'true');
  await expect.poll(() => savedPrefs.highContrast).toBe(false);
});

test('system forced-colors mode uses system surface and text colors', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');
  await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' });
  await page.goto('/?tab=home');

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const card = document.querySelector<HTMLElement>('[data-slot="card"]');
    const button = document.querySelector<HTMLElement>('button[data-slot="button"]');
    const systemPalette = document.createElement('div');
    systemPalette.style.backgroundColor = 'Canvas';
    systemPalette.style.color = 'CanvasText';
    systemPalette.style.borderColor = 'ButtonBorder';
    document.body.append(systemPalette);
    const systemColors = getComputedStyle(systemPalette);
    const expectedSurface = systemColors.backgroundColor;
    const expectedBorder = systemColors.borderTopColor;
    systemPalette.style.color = 'CanvasText';
    const expectedText = getComputedStyle(systemPalette).color;
    systemPalette.style.backgroundColor = 'ButtonFace';
    const expectedButtonBackground = getComputedStyle(systemPalette).backgroundColor;
    systemPalette.style.color = 'ButtonText';
    const expectedButtonText = getComputedStyle(systemPalette).color;
    systemPalette.remove();
    return {
      background: style.getPropertyValue('--background').trim(),
      foreground: style.getPropertyValue('--foreground').trim(),
      accent: style.getPropertyValue('--color-accent').trim(),
      accentContrast: style.getPropertyValue('--color-accent-contrast').trim(),
      cardBackground: card ? getComputedStyle(card).backgroundColor : '',
      cardText: card ? getComputedStyle(card).color : '',
      cardBorder: card ? getComputedStyle(card).borderTopColor : '',
      buttonBackground: button ? getComputedStyle(button).backgroundColor : '',
      buttonText: button ? getComputedStyle(button).color : '',
      expectedSurface,
      expectedText,
      expectedButtonBackground,
      expectedButtonText,
      expectedBorder,
    };
  });

  expect(colors).toMatchObject({
    background: 'Canvas',
    foreground: 'CanvasText',
    accent: 'Highlight',
    accentContrast: 'HighlightText',
    cardBackground: colors.expectedSurface,
    cardText: colors.expectedText,
    cardBorder: colors.expectedBorder,
    buttonBackground: colors.expectedButtonBackground,
    buttonText: colors.expectedButtonText,
  });
  await expectAccessible(page);
});

test('populated device management and preflight dialog meet accessibility checks', async ({ page }) => {
  const device = {
    id: 'test-device',
    name: 'Lab iPad',
    transport: 'usb',
    port: 22,
    user: 'mobile',
    udid: '00008110-001234567890001E',
    productType: 'iPad14,1',
    enabled: true,
    isPrimary: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const health = {
    reachable: true,
    screenIsOn: false,
    batteryPercent: 82,
    checkedAt: Date.now(),
    readiness: { score: 100, state: 'ready', reasons: [] },
    subsystems: { usb: 'ready', mux: 'ready', agent: 'ready', appStore: 'ready', testFlight: 'ready', sshTunnel: 'ready' },
  };

  await mockAuthenticatedSession(page, '2097152');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [device],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/events', async (route) => {
    await route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  });
  await page.route('**/v1/dashboard/devices/test-device/health*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(health) });
  });
  const activityEntries = Array.from({ length: 100 }, (_, index) => ({
    id: `activity-${index}`,
    ts: Date.now() - index * 60_000,
    deviceId: device.id,
    kind: 'health',
    message: `Device activity ${String(index).padStart(3, '0')}`,
  }));
  await page.route('**/v1/dashboard/devices/test-device/activity*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ activity: cursor ? activityEntries.slice(50) : activityEntries.slice(0, 50), total: activityEntries.length, nextCursor: cursor ? undefined : 'activity-older' }),
    });
  });
  await page.route('**/v1/dashboard/devices/test-device/preflight', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ device, health, ready: true, checks: [{ label: 'USB transport', ok: true, detail: 'Device agent is reachable.' }] }),
    });
  });

  await page.addInitScript(() => {
    localStorage.setItem('onboardingTourSeen', 'true');
    localStorage.setItem('onboardingDismissed', 'true');
  });
  await page.goto('/?tab=settings&stab=devices');
  await expect(page.getByText('Lab iPad', { exact: true })).toBeVisible();
  await expect(page.getByText('online', { exact: true })).toBeVisible();
  const activityList = page.getByRole('list', { name: 'Lab iPad activity' });
  const activityViewport = page.getByRole('region', { name: 'Lab iPad activity scroll area' });
  await expect(activityList.getByRole('listitem').first()).toContainText('Device activity 000');
  await expect.poll(() => activityList.getByRole('listitem').count()).toBeLessThan(40);
  await page.getByRole('button', { name: 'Load older (50)' }).click();
  await expect(activityList.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => activityViewport.evaluate((element) => element.scrollHeight)).toBeGreaterThan(2000);
  await activityViewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(activityList.getByText('Device activity 099')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Preflight' }).click();
  await expect(page.getByText('Device preflight')).toBeVisible();
  await expect(page.getByText('ready for automation')).toBeVisible();
  await expectAccessible(page);
});

test('IPA Library virtualizes loaded rows and reveals artifact provenance on demand', async ({ page }) => {
  const sha256 = 'a'.repeat(64);
  const warning = 'Payload/Example.app/Extensions/Share.appex/Share still encrypted (cryptid != 0)';
  const artifacts = Array.from({ length: 100 }, (_, index) => ({
    id: `artifact-${index}`,
    key: `com.example.provenance${index ? `.${index}` : ''}:appstore:${123 + index}`,
    projectIds: ['default'],
    bundleId: `com.example.provenance${index ? `.${index}` : ''}`,
    channel: 'appstore',
    versionLabel: '2.4.0',
    buildNumber: `${240 + index}`,
    fileSizeBytes: 1024 * 1024,
    sha256,
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 3,
    sourceJobId: `job-provenance-${index}`,
    warnings: index === 0 ? [warning] : [],
    fileUrl: `/v1/dashboard/artifacts/artifact-${index}/file`,
  }));

  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/artifacts*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        artifacts,
        total: artifacts.length,
        totalBytes: artifacts.length * 1024 * 1024,
        maxBytes: 1024 * 1024 * 10,
      }),
    });
  });

  await mockStableDashboardEvents(page);

  const artifactResponse = page.waitForResponse((response) => response.url().includes('/v1/dashboard/artifacts?') && response.ok());
  await page.goto('/');
  await artifactResponse;
  const list = page.getByRole('list', { name: 'IPA library artifacts' });
  const viewport = page.getByRole('region', { name: 'IPA library artifacts list region' });
  const artifact = list.getByRole('listitem').filter({ hasText: 'com.example.provenance' }).first();
  await expect(artifact).toBeVisible();
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(100);
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  const details = artifact.locator('summary').filter({ hasText: 'Artifact details' });
  await expect(details).toBeVisible();
  await expect(artifact.getByText(sha256, { exact: true })).not.toBeVisible();

  await details.click();
  await expect(artifact.getByText(sha256, { exact: true })).toBeVisible();
  await expect(artifact.getByText('job-provenance-0', { exact: true })).toBeVisible();
  await expect(artifact.getByText(warning, { exact: true })).toBeVisible();
  await viewport.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + bounds.bottom - window.innerHeight, behavior: 'instant' });
  });
  await expect(list.locator('[aria-posinset="100"]')).toBeAttached();
  await expect(list.getByText('com.example.provenance.99', { exact: true }).first()).toBeVisible();
  await viewport.evaluate((element) => window.scrollTo({ top: window.scrollY + element.getBoundingClientRect().top - 80, behavior: 'instant' }));
  await expect(list.locator('[aria-posinset="1"]')).toBeAttached();
  await expect(artifact.getByText(sha256, { exact: true })).toBeVisible();
});

test('IPA Library bulk pinning sends one bounded update for the selected artifacts', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '8589934593');
  const artifact = {
    id: 'bulk-artifact-a',
    key: 'com.example.bulk:appstore:123',
    projectIds: ['default'],
    bundleId: 'com.example.bulk',
    channel: 'appstore',
    versionLabel: '2.4.0',
    buildNumber: '240',
    fileSizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-25T12:00:00.000Z',
    lastAccessedAt: '2026-09-25T13:00:00.000Z',
    accessCount: 1,
    fileUrl: '/v1/dashboard/artifacts/bulk-artifact-a/file',
  };
  const bulkRequests: Array<{ ids: string[]; pinned: boolean }> = [];
  let artifactPinnedAt: string | undefined;
  await page.route('**/v1/dashboard/apps/metadata?*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
  });
  await page.route('**/v1/dashboard/artifacts**', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { ids: string[]; pinned: boolean };
      bulkRequests.push(payload);
      artifactPinnedAt = payload.pinned ? '2026-09-26T13:00:00.000Z' : undefined;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          pinned: payload.pinned,
          changedIds: payload.ids,
          artifacts: payload.ids.map((artifactId) => ({ artifactId, pinned: payload.pinned, pinnedAt: artifactPinnedAt })),
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ artifacts: [{ ...artifact, pinnedAt: artifactPinnedAt }], total: 1, totalBytes: 1024, maxBytes: 10240 }),
    });
  });

  const artifactResponse = page.waitForResponse((response) => response.url().includes('/v1/dashboard/artifacts?') && response.ok());
  await page.goto('/?tab=home');
  await artifactResponse;
  await page.getByRole('checkbox', { name: 'Select com.example.bulk 2.4.0 (240)' }).check();
  await page.getByRole('button', { name: 'Pin selected', exact: true }).click();

  await expect.poll(() => bulkRequests.length).toBe(1);
  expect(bulkRequests[0]).toEqual({ ids: ['bulk-artifact-a'], pinned: true });
  await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pin selected', exact: true })).not.toBeVisible();
});

test('audit history virtualizes entries without losing older records', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '135168');
  const entries = Array.from({ length: 100 }, (_, index) => ({
    id: `audit-${index}`,
    ts: Date.now() - index * 60_000,
    actor: `manager-${index}`,
    action: 'user.add',
    target: `member-${index}`,
    detail: `Granted access ${String(index).padStart(3, '0')}`,
  }));
  await page.route('**/v1/dashboard/users', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ users: [] }) });
  });
  await page.route('**/v1/dashboard/roles', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ roles: [] }) });
  });
  await page.route('**/v1/dashboard/audit-log*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ entries, total: entries.length }) });
  });

  await page.goto('/?tab=settings&stab=users');

  const list = page.getByRole('list', { name: 'Audit log entries' });
  const viewport = page.getByRole('region', { name: 'Audit log entries scroll area' });
  await expect(list.getByRole('listitem').first()).toContainText('Granted access 000');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-posinset', '1');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(60);

  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(list.getByText('member-99', { exact: true })).toBeVisible();
  await expectAccessible(page);
});

test('bulk retry queues only failures, continues after an error, and exports per-job results', async ({ page }) => {
  const entries = [
    {
      id: 'job-done',
      bundleId: 'com.example.done',
      status: 'done',
      source: 'manual',
      createdAt: 1000,
      finishedAt: 2000,
      fileAvailable: true,
    },
    {
      id: 'job-network-failure',
      bundleId: 'com.example.network-failure',
      status: 'failed',
      source: 'manual',
      createdAt: 1000,
      finishedAt: 3000,
      error: 'device transport failed',
      fileAvailable: false,
    },
    {
      id: 'job-queued-success',
      bundleId: 'com.example.queued-success',
      status: 'failed',
      source: 'manual',
      createdAt: 1000,
      finishedAt: 4000,
      error: 'device transport failed',
      fileAvailable: false,
    },
  ];
  const attemptedBundleIds: string[] = [];
  const queuedBundleIds: string[] = [];

  await mockAuthenticatedDashboard(page, '1');
  await mockStableDashboardEvents(page);
  await page.route('**/v1/dashboard/jobs?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ history: entries, total: entries.length }),
    });
  });
  await page.route('**/v1/dashboard/jobs/bulk-preview', async (route) => {
    const body = route.request().postDataJSON() as { ids: string[] };
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        requested: body.ids.length,
        eligible: body.ids.length,
        projectedQueueAdds: body.ids.length,
        estimatedDurationMs: 60_000,
        previousSizeBytes: 0,
        items: body.ids.map((id) => ({
          id,
          bundleId: entries.find((entry) => entry.id === id)?.bundleId,
          status: entries.find((entry) => entry.id === id)?.status,
          action: 'queue',
        })),
      }),
    });
  });
  await page.route('**/v1/dashboard/decrypt', async (route) => {
    const body = route.request().postDataJSON() as { bundleId: string };
    attemptedBundleIds.push(body.bundleId);
    if (body.bundleId === 'com.example.network-failure') {
      await route.abort('failed');
      return;
    }
    queuedBundleIds.push(body.bundleId);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'job-retry',
        bundleId: body.bundleId,
        source: 'manual',
        status: 'queued',
        progress: 'Queued',
        createdAt: new Date().toISOString(),
        queue: { position: 1, total: 1 },
      }),
    });
  });

  await page.goto('/');
  await expect(page.getByRole('checkbox', { name: 'Select or unselect all loaded jobs' })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select or unselect all loaded jobs' }).click();

  const retryFailedOnly = page.getByRole('button', { name: 'Retry failed only (2)' });
  await expect(retryFailedOnly).toBeVisible();
  const previewRequest = page.waitForRequest((request) => request.url().includes('/v1/dashboard/jobs/bulk-preview'));
  await retryFailedOnly.click();
  expect((await previewRequest).postDataJSON()).toMatchObject({ ids: ['job-network-failure', 'job-queued-success'], projectId: 'default' });

  await expect(page.getByText('Preview bulk decrypt')).toBeVisible();
  await page.getByRole('button', { name: 'Queue 2', exact: true }).click();
  await expect.poll(() => attemptedBundleIds).toEqual(['com.example.network-failure', 'com.example.queued-success']);
  await expect.poll(() => queuedBundleIds).toEqual(['com.example.queued-success']);

  const retryResults = page.getByRole('region', { name: 'Bulk retry results' });
  await expect(retryResults.getByRole('status')).toContainText('1 queued · 1 failed · 0 already active');
  await expect(retryResults).toContainText('network error');

  const csvDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export retry results CSV' }).click();
  const csvDownload = await csvDownloadPromise;
  expect(csvDownload.suggestedFilename()).toBe('dkrypt-bulk-retry-results.csv');
  const csvPath = await csvDownload.path();
  expect(csvPath).toBeTruthy();
  const csvContent = await readFile(csvPath as string, 'utf8');
  expect(csvContent).toContain('com.example.network-failure');
  expect(csvContent).toContain('com.example.queued-success');

  const jsonDownloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export retry results JSON' }).click();
  const jsonDownload = await jsonDownloadPromise;
  expect(jsonDownload.suggestedFilename()).toBe('dkrypt-bulk-retry-results.json');
  const jsonPath = await jsonDownload.path();
  expect(jsonPath).toBeTruthy();
  expect(JSON.parse(await readFile(jsonPath as string, 'utf8'))).toMatchObject([
    { historyJobId: 'job-network-failure', bundleId: 'com.example.network-failure', outcome: 'failed' },
    { historyJobId: 'job-queued-success', bundleId: 'com.example.queued-success', outcome: 'queued' },
  ]);
});

test('TestFlight shortcuts reappear from the account cache while a reload refresh is pending', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '17179869186');

  let catalogCalls = 0;
  let holdCatalogResponse = false;
  let refreshingEmptyCatalogDelivered = false;
  let releaseReloadResponse!: () => void;
  let reloadRequestStarted!: () => void;
  const reloadResponse = new Promise<void>((resolve) => (releaseReloadResponse = resolve));
  const reloadRequest = new Promise<void>((resolve) => (reloadRequestStarted = resolve));
  await page.route('**/v1/dashboard/testflight/catalog*', async (route) => {
    catalogCalls += 1;
    if (holdCatalogResponse) {
      reloadRequestStarted();
      await reloadResponse;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ apps: [], fetchedAt: Date.now(), refreshing: true }),
      });
      refreshingEmptyCatalogDelivered = true;
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        apps: [{
          appId: 123,
          bundleId: 'com.example.testflight',
          displayName: 'Example TestFlight App',
          devices: [{ id: 'ipad-1', name: 'Lab iPad' }],
          lastVerifiedAt: Date.now() - 60 * 60_000,
          deviceSource: true,
        }],
        fetchedAt: Date.now(),
        refreshing: false,
      }),
    });
  });

  await page.goto('/');
  const shortcut = page.getByRole('button', { name: /Example TestFlight App/ });
  await expect(shortcut).toBeVisible();
  await expect(page.getByRole('status', { name: 'TestFlight availability may be out of date' })).toBeVisible();
  holdCatalogResponse = true;
  try {
    await page.reload();
    await reloadRequest;
    await expect(shortcut).toBeVisible();
  } finally {
    releaseReloadResponse();
  }
  await expect.poll(() => refreshingEmptyCatalogDelivered).toBe(true);
  await expect.poll(() => catalogCalls).toBeGreaterThanOrEqual(2);
  await expect(shortcut).toBeVisible();
  await expect(page.getByRole('status', { name: 'Refreshing TestFlight availability' })).toBeVisible();
  const cachedBundleId = await page.evaluate(() => {
    const cached = sessionStorage.getItem('dkrypt:testflight-catalog:v1:member');
    return cached ? (JSON.parse(cached) as { apps?: Array<{ bundleId?: string }> }).apps?.[0]?.bundleId : undefined;
  });
  expect(cachedBundleId).toBe('com.example.testflight');
  await expectAccessible(page);
});

test('TestFlight catalog refresh failures offer a retry instead of an empty-state message', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '17179869186');
  let catalogCalls = 0;
  let retryRequested = false;
  await page.route('**/v1/dashboard/testflight/catalog*', async (route) => {
    catalogCalls += 1;
    if (!retryRequested) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'TestFlight is temporarily unavailable' }),
      });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ apps: [], fetchedAt: Date.now(), refreshing: false }),
    });
  });

  await page.goto('/');
  await expect.poll(() => catalogCalls).toBeGreaterThan(0);
  await expect(page.getByText('Couldn’t check TestFlight availability.', { exact: true })).toBeVisible();
  await expect(page.getByText('No TestFlight apps yet.')).toHaveCount(0);
  retryRequested = true;
  await page.getByRole('button', { name: 'Retry TestFlight availability' }).click();
  await expect(page.getByText('No TestFlight apps yet.')).toBeVisible();
  await expect.poll(() => catalogCalls).toBeGreaterThanOrEqual(2);
  await expectAccessible(page);
});

test('operational logs render a small accessible window and older rows remain reachable by scrolling', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2048');
  const logs = Array.from({ length: 100 }, (_, index) => ({
    id: `virtual-log-${index}`,
    ts: Date.now() - index * 1_000,
    level: 'info',
    scope: 'scheduler',
    message: `virtual log entry ${String(index).padStart(3, '0')}`,
    meta: { index },
  }));
  await page.route('**/v1/dashboard/logs*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ logs, total: logs.length }),
    });
  });

  await page.goto('/?tab=logs');

  const list = page.getByRole('list', { name: 'Operational log entries' });
  const viewport = page.getByRole('region', { name: 'Operational log entries scroll area' });
  await expect(list.getByRole('listitem').first()).toContainText('virtual log entry 000');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-posinset', '1');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(60);

  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(list.getByText('virtual log entry 099')).toBeVisible();
  await expect(list.getByRole('listitem').last()).toHaveAttribute('aria-posinset', '100');
  await expectAccessible(page);
});

test('dashboard notifications virtualize older entries while keeping them scrollable', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2048');
  const notifications = Array.from({ length: 100 }, (_, index) => {
    const createdAt = Date.now() - index * 1_000;
    return {
      id: `virtual-notification-${index}`,
      title: `History notification ${String(index).padStart(3, '0')}`,
      message: 'This notification remains available in the account history.',
      severity: 'info',
      createdAt,
      readAt: Date.now(),
      ...(index === 0 ? {
        occurrenceCount: 3,
        firstOccurredAt: createdAt - 20_000,
        lastOccurredAt: createdAt,
        deviceId: 'device-1',
        href: '/?tab=settings&stab=devices#device-device-1',
      } : {}),
      ...(index === 1 ? {
        deploymentId: 'run-notification-2',
        href: '/?tab=settings&stab=doctor#deployment-run-notification-2',
      } : {}),
    };
  });
  let notificationRequests = 0;
  await page.route('**/v1/dashboard/notifications*', async (route) => {
    notificationRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ notifications, unread: 0, total: notifications.length }),
    });
  });

  await page.goto('/?tab=home');
  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect.poll(() => notificationRequests).toBeGreaterThan(0);

  const list = page.getByRole('list', { name: 'Dashboard notifications' });
  const viewport = page.getByRole('region', { name: 'Dashboard notifications scroll area' });
  await expect(list.getByRole('listitem').first()).toContainText('History notification 000');
  await expect(list.getByText(/Occurred 3 times · last/)).toBeVisible();
  await expect(list.getByRole('link', { name: 'Open device' })).toHaveAttribute('href', '/?tab=settings&stab=devices#device-device-1');
  await expect(list.getByRole('link', { name: 'Open deployment' })).toHaveAttribute('href', '/?tab=settings&stab=doctor#deployment-run-notification-2');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-posinset', '1');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(60);

  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(list.getByText('History notification 099')).toBeVisible();
  await expect(list.getByRole('listitem').last()).toHaveAttribute('aria-posinset', '100');
  await expectAccessible(page);
});

test('device and deployment notification links reach targets rendered after asynchronous loads', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 240 });
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '128');
  await page.unroute('**/v1/dashboard/overview*');
  await page.route('**/v1/dashboard/overview*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        schedulerEnabled: false,
        settings: {},
        watches: [],
        devices: [
          ...Array.from({ length: 5 }, (_, index) => ({
            id: `device-before-${index}`,
            name: `iPad ${index}`,
            productType: 'iPad13,8',
            transport: 'usb',
            enabled: true,
            isPrimary: false,
            udid: `udid-before-${index}`,
          })),
          { id: 'device-target', name: 'Target iPad', productType: 'iPad13,8', transport: 'usb', enabled: true, isPrimary: true, udid: 'udid-target' },
        ],
        schedulerRunHistory: [],
        disk: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0 },
        isPaidPlan: false,
        maintenance: { active: false, manual: false, auto: false },
        activeJobs: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/doctor', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        checkedAt: new Date().toISOString(),
        checks: [],
        deployment: { id: 'run-notification-target', ref: 'abcdef0123456789' },
      }),
    });
  });
  const notifications = [
    {
      id: 'device-target-notification',
      title: 'Device unavailable',
      message: 'The target device needs attention.',
      severity: 'error',
      createdAt: Date.now(),
      readAt: Date.now(),
      deviceId: 'device-target',
      href: '/?tab=settings&stab=devices#device-device-target',
    },
    {
      id: 'deployment-target-notification',
      title: 'Deployment ready',
      message: 'A deployment is live.',
      severity: 'success',
      createdAt: Date.now() - 1,
      readAt: Date.now(),
      deploymentId: 'run-notification-target',
      href: '/?tab=settings&stab=doctor#deployment-run-notification-target',
    },
  ];
  await page.route('**/v1/dashboard/notifications*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ notifications, unread: 0, total: notifications.length }) });
  });

  await page.goto('/?tab=home');
  await page.getByRole('button', { name: 'Notifications' }).click();
  await page.getByRole('link', { name: 'Open device' }).click();
  const deviceTarget = page.locator('#device-device-target');
  await expect(deviceTarget).toBeVisible();
  await expect.poll(() => deviceTarget.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    return top > -30 && top < 100;
  })).toBe(true);

  await page.getByRole('button', { name: 'Notifications' }).click();
  await page.getByRole('link', { name: 'Open deployment' }).click();
  const deploymentTarget = page.locator('#deployment-run-notification-target');
  await expect(deploymentTarget).toBeVisible();
  await expect.poll(() => deploymentTarget.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    return top > -30 && top < 100;
  })).toBe(true);
});

test('job history stays virtualized as older cursor pages are loaded', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  const finishedAt = Date.now() - 60_000;
  const entries = Array.from({ length: 100 }, (_, index) => ({
    id: `history-${index}`,
    bundleId: `com.example.history.${String(index).padStart(3, '0')}`,
    status: 'done',
    source: 'manual',
    createdAt: finishedAt - 5_000,
    finishedAt,
    fileAvailable: false,
  }));
  await page.route('**/v1/dashboard/jobs?*', async (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor');
    const start = cursor ? Number(cursor.replace('history-', '')) : 0;
    const history = entries.slice(start, start + 15);
    const nextStart = start + history.length;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        history,
        total: entries.length,
        nextCursor: nextStart < entries.length ? `history-${nextStart}` : undefined,
      }),
    });
  });

  await page.goto('/?tab=home');

  const list = page.getByRole('list', { name: 'Job history entries' });
  const viewport = page.getByRole('region', { name: 'Job history entries scroll area' });
  await expect(list.getByText('com.example.history.000')).toBeVisible();
  const firstRow = list.getByRole('listitem').first();
  await expect(firstRow).toHaveAttribute('aria-setsize', '15');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(20);

  let expectedSize = 15;
  while (expectedSize < entries.length) {
    const nextSize = Math.min(expectedSize + 15, entries.length);
    await page.getByRole('button', { name: /Load more/ }).click();
    await expect(firstRow).toHaveAttribute('aria-setsize', String(nextSize));
    expectedSize = nextSize;
  }

  await expect(list.getByText('com.example.history.099')).toHaveCount(0);
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => viewport.evaluate((element) => element.scrollHeight)).toBeGreaterThan(5000);
  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(list.getByText('com.example.history.099')).toBeVisible();
  await expect(list.getByRole('listitem').last()).toHaveAttribute('aria-posinset', '100');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(35);
  await expectAccessible(page);
});

test('job details show the persisted queue blocker alongside retry guidance', async ({ page }) => {
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  const queueReason = 'No enabled device is eligible for this scheduled job.';
  await page.route('**/v1/dashboard/jobs/queue-timeout/timeline', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'queue-timeout',
        correlationId: 'queue-timeout',
        bundleId: 'com.example.queued',
        status: 'failed',
        queueReason,
        events: [{ at: Date.now() - 30_000, label: 'Failed: job deadline exceeded while waiting in the queue', status: 'failed' }],
        guidance: {
          category: 'Queue wait expired',
          title: 'Queue wait expired',
          action: 'Resolve the queue blocker shown in the job timeline or device status, then retry.',
          retryRecommended: true,
        },
      }),
    });
  });

  await page.goto('/?tab=home&job=queue-timeout');

  await expect(page.getByText(queueReason, { exact: true })).toBeVisible();
  await expect(page.getByText('Resolve the queue blocker shown in the job timeline or device status, then retry.', { exact: true })).toBeVisible();
});

test('release comparisons show build numbers, release notes, metadata freshness, and cache reuse', async ({ page }) => {
  const bundleId = 'com.example.release-comparison';
  const finishedAt = Date.now() - 60_000;
  const entries = [
    {
      id: 'comparison-appstore',
      bundleId,
      versionLabel: '1.0',
      status: 'done',
      source: 'manual',
      createdAt: finishedAt - 5_000,
      finishedAt,
      fileAvailable: false,
      cacheHit: true,
      ipaMetadata: { shortVersion: '1.0', bundleVersion: '100' },
    },
    {
      id: 'comparison-testflight',
      bundleId,
      versionLabel: '1.1',
      status: 'done',
      source: 'manual',
      createdAt: finishedAt,
      finishedAt: finishedAt + 1,
      fileAvailable: false,
      testflight: {
        appId: 123,
        build: {
          id: 456,
          bundleId,
          cfBundleShortVersion: '1.1',
          cfBundleVersion: '101',
          whatsNew: 'TestFlight build notes',
        },
      },
    },
  ];

  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '2');
  await page.route('**/v1/dashboard/jobs?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ history: entries, total: entries.length }),
    });
  });
  await page.route('**/v1/dashboard/jobs/stats/*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        bundleId,
        totalRuns: 2,
        doneCount: 2,
        failedCount: 0,
        successRate: 1,
        avgDurationMs: 1_000,
        lastRunAt: finishedAt,
        failureBreakdown: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/jobs/diff*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        a: { id: entries[0].id, versionLabel: '1.0', buildNumber: '100', channel: 'appstore', cacheHit: true, finishedAt },
        b: { id: entries[1].id, versionLabel: '1.1', buildNumber: '101', releaseNotes: 'TestFlight build notes', channel: 'testflight', finishedAt: finishedAt + 1 },
        sizeDeltaBytes: 0,
        plistDiff: [],
      }),
    });
  });
  await page.route('**/v1/dashboard/apps/metadata*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        entries: [{
          bundleId,
          displayName: 'Release comparison app',
          releaseNotes: 'Latest App Store notes',
          metadataFetchedAt: Date.now(),
          updatedAt: Date.now(),
        }],
      }),
    });
  });

  await page.goto('/?tab=home');
  const jobHistory = page.getByRole('heading', { name: 'Job history' });
  await jobHistory.scrollIntoViewIfNeeded();
  const statsButton = page.getByRole('button', { name: 'Release comparison app', exact: true }).first();
  await expect(statsButton).toBeVisible();
  await statsButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Versions - pick 2 to compare');
  const appStoreBuild = dialog.getByRole('checkbox', { name: 'Select 1.0, build 100' });
  const testFlightBuild = dialog.getByRole('checkbox', { name: 'Select 1.1, build 101' });
  await appStoreBuild.click();
  await testFlightBuild.click();
  await dialog.getByRole('button', { name: 'Compare' }).click();
  await expect(dialog).toContainText('build 100');
  await expect(dialog).toContainText('build 101');
  await expect(dialog).toContainText('reused existing IPA');
  await expect(dialog).toContainText('TestFlight build notes');
  await expect(dialog).toContainText('App Store metadata');
  await expect(dialog).toContainText('Latest App Store notes');
  await expectAccessible(page, '[role="dialog"]');
});
