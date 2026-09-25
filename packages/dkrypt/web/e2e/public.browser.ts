import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map(({ id, impact, help, nodes }) => ({
    id,
    impact,
    help,
    nodes: nodes.map(({ target, html, failureSummary }) => ({ target, html, failureSummary })),
  }))).toEqual([]);
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

async function mockStableDashboardEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
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

test('pricing plan checkout actions share a bottom baseline', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/pricing');

  const buttons = page.getByRole('link', { name: 'Sign in to subscribe' });
  const paymentDetails = page.getByText('Stripe or crypto checkout', { exact: true });
  await expect(buttons).toHaveCount(4);
  await expect(paymentDetails).toHaveCount(4);
  const priceTops = await page.locator('[data-slot="card"] .text-3xl').evaluateAll((prices) => prices.map((price) => price.getBoundingClientRect().top));
  expect(Math.max(...priceTops) - Math.min(...priceTops)).toBeLessThanOrEqual(2);
  const bottoms = await buttons.evaluateAll((links) => links.map((link) => link.getBoundingClientRect().bottom));
  expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(2);
  const widths = await buttons.evaluateAll((links) => links.map((link) => link.getBoundingClientRect().width));
  const paymentDetailWidths = await paymentDetails.evaluateAll((details) => details.map((detail) => detail.getBoundingClientRect().width));
  expect(widths.every((width, index) => Math.abs(width - (paymentDetailWidths[index] ?? 0)) <= 2)).toBe(true);
  const paymentDetailTops = await paymentDetails.evaluateAll((details) => details.map((detail) => detail.getBoundingClientRect().top));
  expect(Math.max(...paymentDetailTops) - Math.min(...paymentDetailTops)).toBeLessThanOrEqual(2);
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
  await page.route('**/v1/dashboard/devices/test-device/activity*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ activity: [{ id: 'activity-1', ts: Date.now(), deviceId: device.id, kind: 'health', message: 'Connected over USB' }], total: 1 }),
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
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Preflight' }).click();
  await expect(page.getByText('Device preflight')).toBeVisible();
  await expect(page.getByText('ready for automation')).toBeVisible();
  await expectAccessible(page);
});

test('IPA Library reveals artifact provenance and decrypt warnings on demand', async ({ page }) => {
  const sha256 = 'a'.repeat(64);
  const warning = 'Payload/Example.app/Extensions/Share.appex/Share still encrypted (cryptid != 0)';

  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/artifacts*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        artifacts: [{
          id: 'artifact-1',
          key: 'com.example.provenance:appstore:123',
          projectIds: ['default'],
          bundleId: 'com.example.provenance',
          channel: 'appstore',
          versionLabel: '2.4.0',
          buildNumber: '240',
          fileSizeBytes: 1024 * 1024,
          sha256,
          createdAt: '2026-09-25T12:00:00.000Z',
          lastAccessedAt: '2026-09-25T13:00:00.000Z',
          accessCount: 3,
          sourceJobId: 'job-provenance-1',
          warnings: [warning],
          fileUrl: '/v1/dashboard/artifacts/artifact-1/file',
        }],
        total: 1,
        totalBytes: 1024 * 1024,
        maxBytes: 1024 * 1024 * 10,
      }),
    });
  });

  await mockStableDashboardEvents(page);

  const artifactResponse = page.waitForResponse((response) => response.url().includes('/v1/dashboard/artifacts?') && response.ok());
  await page.goto('/');
  await artifactResponse;
  const artifact = page.locator('article').filter({ hasText: 'com.example.provenance' });
  await expect(artifact).toBeVisible();
  const details = artifact.locator('summary').filter({ hasText: 'Artifact details' });
  await expect(details).toBeVisible();
  await expect(artifact.getByText(sha256, { exact: true })).not.toBeVisible();

  await details.click();
  await expect(artifact.getByText(sha256, { exact: true })).toBeVisible();
  await expect(artifact.getByText('job-provenance-1', { exact: true })).toBeVisible();
  await expect(artifact.getByText(warning, { exact: true })).toBeVisible();
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
