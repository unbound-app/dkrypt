import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { renderPublicPage } from './publicPages.js';

const shell = '<html><body><div id="app-root"></div></body></html>';
const browserShell = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

describe('renderPublicPage', () => {
  test.each([
    ['/', 'subscription service'],
    ['/pricing', '€5/month'],
    ['/terms', 'merchant of record'],
    ['/privacy', 'Privacy notice'],
    ['/refund-policy', '14 days'],
    ['/contact', 'Contact dkrypt'],
  ])('renders public fallback content for %s', (pathname, expected) => {
    const rendered = renderPublicPage(shell, pathname);

    expect(rendered).toContain('data-app-fallback');
    expect(rendered).toContain(expected);
    expect(rendered).toContain('contact<span>@</span>dylib.dev');
    expect(rendered).not.toContain('<div id="app-root"></div>');
  });

  test('hides the fallback before the app module loads in JavaScript browsers', () => {
    const rendered = renderPublicPage(browserShell, '/');
    const activationIndex = rendered.indexOf("document.documentElement.classList.add('js')");
    const fallbackIndex = rendered.indexOf('<div data-app-fallback');

    expect(activationIndex).toBeGreaterThan(-1);
    expect(rendered).toContain('html.js [data-app-fallback]');
    expect(activationIndex).toBeLessThan(fallbackIndex);
    expect(rendered).not.toContain('<div data-app-fallback hidden');
  });

  test('renders distinct monthly prices for every paid tier', () => {
    const rendered = renderPublicPage(shell, '/pricing');

    expect(rendered).toContain('Regular — €5/month');
    expect(rendered).toContain('Priority — €10/month');
    expect(rendered).toContain('API — €15/month');
    expect(rendered).toContain('Priority API — €20/month');
  });
});
