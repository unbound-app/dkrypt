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

test('authenticated top bar exposes community links without mobile overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAuthenticatedSession(page, '1');
  await page.route('**/v1/dashboard/overview', async (route) => {
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
