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
  await mockStableDashboardEvents(page);
  await mockAuthenticatedDashboard(page, '1');
  await page.route('**/v1/dashboard/watches/calendar*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        fromAt: Date.parse('2026-10-25T08:00:00.000Z'),
        untilAt: Date.parse('2026-10-26T08:00:00.000Z'),
        runs: [{ watchId: 'watch-quiet', bundleId: 'com.example.quiet', at: Date.parse('2026-10-25T09:00:00.000Z'), deferred: true }],
        truncated: false,
      }),
    });
  });

  await page.goto('/?tab=settings&stab=scheduler');
  await page.getByRole('button', { name: 'Preview next 24 hours' }).click();
  await expect(page.getByRole('heading', { name: 'Next 24 hours' })).toBeVisible();
  await expect(page.getByText('After quiet hours')).toBeVisible();
  await expect(page.getByText('com.example.quiet')).toBeVisible();
  await expectAccessible(page);
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
      }),
    });
  });

  await page.goto('/?tab=settings&stab=doctor');

  await expect(page.getByRole('heading', { name: 'System doctor' })).toBeVisible();
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
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, checkedAt: '2026-09-27T12:00:00.000Z', checks: [] }) });
  });

  await page.goto('/?tab=settings&stab=doctor');

  await expect(page.getByRole('tab', { name: 'Devices' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'System' })).toHaveCount(0);
  expect(doctorRequests).toBe(0);
});

test('device managers can run read-only synthetic service probes', async ({ page }) => {
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
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, checkedAt: '2026-09-27T12:00:00.000Z', checks: [] }) });
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
  expect(probeRequests).toBe(0);
  await page.getByRole('button', { name: 'Run live probes' }).click();

  await expect(page.getByText('Live service probes')).toBeVisible();
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
  await expectAccessible(page);
});

test('authenticated dashboard shows the running build revision', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');

  await page.goto('/');

  await expect(page.getByText('Build abcdef0', { exact: true })).toBeVisible();
});

test('API documentation opens in a standalone page instead of an embedded frame', async ({ page }) => {
  await mockAuthenticatedDashboard(page, '1');

  await page.goto('/?tab=docs');
  const referenceLink = page.getByRole('link', { name: 'Open API reference' });

  await expect(referenceLink).toBeVisible();
  await expect(referenceLink).toHaveAttribute('href', '/reference/');
  await expect(referenceLink).toHaveAttribute('target', '_blank');
  await expect(page.locator('iframe[title="dkrypt API reference"]')).toHaveCount(0);
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

test('IPA Library reveals artifact provenance and decrypt warnings on demand', async ({ page }) => {
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
  const viewport = page.getByRole('region', { name: 'IPA library artifacts scroll area' });
  const artifact = list.getByRole('listitem').filter({ hasText: 'com.example.provenance' }).first();
  await expect(artifact).toBeVisible();
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(60);
  const details = artifact.locator('summary').filter({ hasText: 'Artifact details' });
  await expect(details).toBeVisible();
  await expect(artifact.getByText(sha256, { exact: true })).not.toBeVisible();

  await details.click();
  await expect(artifact.getByText(sha256, { exact: true })).toBeVisible();
  await expect(artifact.getByText('job-provenance-0', { exact: true })).toBeVisible();
  await expect(artifact.getByText(warning, { exact: true })).toBeVisible();
  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(list.getByText('com.example.provenance.99', { exact: true }).first()).toBeVisible();
  await viewport.evaluate((element) => { element.scrollTop = 0; });
  await expect(artifact.getByText(sha256, { exact: true })).toBeVisible();
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
  const notifications = Array.from({ length: 100 }, (_, index) => ({
    id: `virtual-notification-${index}`,
    title: `History notification ${String(index).padStart(3, '0')}`,
    message: 'This notification remains available in the account history.',
    severity: 'info',
    createdAt: Date.now() - index * 1_000,
    readAt: Date.now(),
  }));
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
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-posinset', '1');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', '100');
  await expect.poll(() => list.getByRole('listitem').count()).toBeLessThan(60);

  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(list.getByText('History notification 099')).toBeVisible();
  await expect(list.getByRole('listitem').last()).toHaveAttribute('aria-posinset', '100');
  await expectAccessible(page);
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
