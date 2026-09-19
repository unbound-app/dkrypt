import { BridgeError } from '#idevice.js';
import { uninstallFromDevice } from '#appStoreInstall.js';
import { searchApps, type ItunesSearchResult } from '#scheduler/itunes.js';
import {
  ensureTestFlightSubscriptionDevices,
  getTestFlightSubscriptions,
  getDevice,
  getEffectiveDevices,
  getTestFlightSubscription,
  recordDeviceActivity,
  recordNotification,
  recordTestFlightSubscriptionSync,
  updateTestFlightSubscriptionDevice,
  withdrawTestFlightSubscription,
  type DeviceRecord,
  type TestFlightSubscription,
  type TestFlightSubscriptionDevice,
} from '#store/state.js';
import { statusTestFlightInvite, subscribeToTestFlightInvite, unsubscribeFromTestFlightInvite } from '#testflight.js';

export const TESTFLIGHT_VERIFICATION_TTL_MS = 30 * 60_000;
const TESTFLIGHT_INVITE_PATH = /^\/join\/([A-Za-z0-9]{4,32})\/?$/;
const TESTFLIGHT_HTML_LIMIT = 2_000_000;
const TESTFLIGHT_SYNC_CONCURRENCY = 3;
const TESTFLIGHT_VERIFICATION_ATTEMPTS = 12;
const TESTFLIGHT_VERIFICATION_DELAY_MS = 1_000;

export interface NormalizedTestFlightInvite {
  url: string;
  inviteCode: string;
}

export interface ResolvedTestFlightInvite {
  appId: number;
  bundleId: string;
  displayName: string;
  iconUrl?: string;
  sellerName?: string;
  category?: string;
}

export interface TestFlightCatalogApp {
  appId: number;
  bundleId: string;
  displayName: string;
  iconUrl?: string;
  sellerName?: string;
  category?: string;
  devices: Array<{ id: string; name: string }>;
  lastVerifiedAt: number;
}

export function normalizeTestFlightInvite(raw: unknown): NormalizedTestFlightInvite {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('a TestFlight public link is required');
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('use a canonical TestFlight link such as https://testflight.apple.com/join/ABC123');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'testflight.apple.com' || parsed.username || parsed.password || parsed.port) {
    throw new Error('only https://testflight.apple.com/join/<code> links are supported');
  }
  const match = parsed.pathname.match(TESTFLIGHT_INVITE_PATH);
  if (!match) throw new Error('only public TestFlight join links are supported');
  return { url: `https://testflight.apple.com/join/${match[1]}`, inviteCode: match[1] };
}

function htmlMetaValue(html: string, attribute: string, value: string): string | undefined {
  const pattern = new RegExp(`<meta[^>]+${attribute}=["']${value}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const reversePattern = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attribute}=["']${value}["'][^>]*>`, 'i');
  return pattern.exec(html)?.[1] ?? reversePattern.exec(html)?.[1];
}

export function parseTestFlightInviteHtml(html: string): { displayName?: string; iconUrl?: string } {
  const title = /<title[^>]*>\s*([^<]+?)\s*<\/title>/i.exec(html)?.[1]?.trim();
  const ogTitle = htmlMetaValue(html, 'property', 'og:title') ?? htmlMetaValue(html, 'name', 'twitter:title');
  const source = ogTitle ?? title;
  const displayName = source
    ?.replace(/^Join the\s+/i, '')
    .replace(/\s+beta\s+-\s+TestFlight(?:\s+-\s+Apple)?\s*$/i, '')
    .replace(/\s+-\s+TestFlight(?:\s+-\s+Apple)?\s*$/i, '')
    .trim();
  const iconUrl = htmlMetaValue(html, 'property', 'og:image') ?? htmlMetaValue(html, 'name', 'twitter:image');
  return { displayName: displayName || undefined, iconUrl };
}

function chooseItunesResult(results: ItunesSearchResult[], displayName: string): ItunesSearchResult | undefined {
  const normalized = displayName.toLowerCase();
  return results.find((result) => result.trackName.toLowerCase() === normalized)
    ?? results.find((result) => result.trackName.toLowerCase().startsWith(normalized))
    ?? results[0];
}

export async function resolveTestFlightInvite(url: string): Promise<ResolvedTestFlightInvite> {
  const normalized = normalizeTestFlightInvite(url);
  const response = await fetch(normalized.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`TestFlight invite could not be resolved (${response.status})`);
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== 'testflight.apple.com') throw new Error('TestFlight invite redirected to an unsupported host');
  }
  const html = await response.text();
  if (html.length > TESTFLIGHT_HTML_LIMIT) throw new Error('TestFlight invite response was unexpectedly large');
  const parsed = parseTestFlightInviteHtml(html);
  const queryCandidates = [...new Set([
    parsed.displayName,
    parsed.displayName?.split(' - ')[0],
  ].filter((value): value is string => Boolean(value?.trim())))];
  if (queryCandidates.length === 0) throw new Error('TestFlight invite did not include app metadata');
  let result: ItunesSearchResult | undefined;
  for (const candidate of queryCandidates) {
    result = chooseItunesResult(await searchApps(candidate), candidate);
    if (result) break;
  }
  if (!result) throw new Error(`could not resolve ${parsed.displayName ?? 'the TestFlight app'} in the App Store`);
  return {
    appId: result.trackId,
    bundleId: result.bundleId,
    displayName: result.trackName,
    iconUrl: result.artworkUrl || parsed.iconUrl,
    sellerName: result.sellerName,
    category: result.category,
  };
}

function cloneDeviceState(device: TestFlightSubscriptionDevice): TestFlightSubscriptionDevice {
  return { ...device };
}

function enabledDeviceMap(): Map<string, DeviceRecord> {
  return new Map(getEffectiveDevices().filter((device) => device.enabled).map((device) => [device.id, device]));
}

function activeDevice(device: TestFlightSubscriptionDevice): { id: string; name: string } | undefined {
  const record = getDevice(device.deviceId);
  if (!record?.enabled || device.status !== 'active' || !device.lastVerifiedAt || Date.now() - device.lastVerifiedAt > TESTFLIGHT_VERIFICATION_TTL_MS) return undefined;
  return { id: record.id, name: record.name };
}

export function getVerifiedTestFlightCatalog(): TestFlightCatalogApp[] {
  const byApp = new Map<number, TestFlightCatalogApp>();
  for (const subscription of listApprovedSubscriptions()) {
    if (!subscription.appId || !subscription.bundleId || !subscription.displayName) continue;
    const active = subscription.devices.map((device) => ({ device, active: activeDevice(device) })).filter((entry): entry is { device: TestFlightSubscriptionDevice; active: { id: string; name: string } } => Boolean(entry.active));
    if (active.length === 0) continue;
    const lastVerifiedAt = Math.max(...active.map(({ device }) => device.lastVerifiedAt ?? 0));
    const existing = byApp.get(subscription.appId);
    if (existing) {
      existing.devices = [...existing.devices, ...active.map(({ active: device }) => device)].filter((device, index, all) => all.findIndex((entry) => entry.id === device.id) === index);
      existing.lastVerifiedAt = Math.max(existing.lastVerifiedAt, lastVerifiedAt);
      continue;
    }
    byApp.set(subscription.appId, {
      appId: subscription.appId,
      bundleId: subscription.bundleId,
      displayName: subscription.displayName,
      iconUrl: subscription.iconUrl,
      sellerName: subscription.sellerName,
      category: subscription.category,
      devices: active.map(({ active: device }) => device),
      lastVerifiedAt,
    });
  }
  return [...byApp.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function decorateSearchResults<T extends { bundleId: string; trackId: number }>(results: T[]): Array<T & { testflight?: Pick<TestFlightCatalogApp, 'appId' | 'devices' | 'lastVerifiedAt'> }> {
  const byBundle = new Map(getVerifiedTestFlightCatalog().map((entry) => [entry.bundleId, entry]));
  const byApp = new Map(getVerifiedTestFlightCatalog().map((entry) => [entry.appId, entry]));
  return results.map((result) => {
    const catalog = byBundle.get(result.bundleId) ?? byApp.get(result.trackId);
    if (!catalog) return result;
    return { ...result, testflight: { appId: catalog.appId, devices: catalog.devices, lastVerifiedAt: catalog.lastVerifiedAt } };
  });
}

function listApprovedSubscriptions(): TestFlightSubscription[] {
  return getSubscriptions().filter((subscription) => subscription.status === 'approved');
}

function getSubscriptions(): TestFlightSubscription[] {
  return getTestFlightSubscriptions();
}

function classifySyncError(error: unknown): TestFlightSubscriptionDevice['status'] {
  if (error instanceof BridgeError && error.details.code && ['unsupported', 'capability_missing', 'incompatible'].includes(error.details.code)) return 'unsupported';
  const message = error instanceof Error ? error.message : String(error);
  if (/unsupported|capabilit|incompatible/i.test(message)) return 'unsupported';
  if (/unreachable|unable to connect|ssh|timed out|timeout|device unavailable|not configured/i.test(message)) return 'unavailable';
  return 'error';
}

async function verifySubscriptionOnDevice(subscription: TestFlightSubscription, device: DeviceRecord): Promise<void> {
  if (!subscription.appId) throw new Error('TestFlight app metadata is missing');
  await subscribeToTestFlightInvite(subscription.url, `${subscription.id}-${device.id}`, device);
  let lastError: unknown;
  for (let attempt = 0; attempt < TESTFLIGHT_VERIFICATION_ATTEMPTS; attempt += 1) {
    try {
      const status = await statusTestFlightInvite(subscription.url, subscription.appId, `${subscription.id}-${device.id}-status-${attempt}`, device);
      if (status.verified === true) return;
      lastError = new Error('TestFlight invite has not appeared for this device yet');
    } catch (error) {
      lastError = error;
    }
    if (attempt < TESTFLIGHT_VERIFICATION_ATTEMPTS - 1) await new Promise((resolve) => setTimeout(resolve, TESTFLIGHT_VERIFICATION_DELAY_MS));
  }
  throw lastError instanceof Error ? lastError : new Error('TestFlight invite could not be verified on this device');
}

async function syncDevice(subscription: TestFlightSubscription, device: DeviceRecord): Promise<TestFlightSubscriptionDevice> {
  updateTestFlightSubscriptionDevice(subscription.id, device.id, { status: 'syncing', lastError: undefined });
  try {
    await verifySubscriptionOnDevice(subscription, device);
    const verifiedAt = Date.now();
    updateTestFlightSubscriptionDevice(subscription.id, device.id, {
      status: 'active',
      appleMembership: 'accepted',
      lastVerifiedAt: verifiedAt,
      lastSyncedAt: verifiedAt,
      lastError: undefined,
    });
    recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: `verified TestFlight access for ${subscription.displayName ?? subscription.url}` });
  } catch (error) {
    const status = classifySyncError(error);
    updateTestFlightSubscriptionDevice(subscription.id, device.id, {
      status,
      appleMembership: 'unknown',
      lastSyncedAt: Date.now(),
      lastError: error instanceof Error ? error.message : String(error),
    });
    recordDeviceActivity({ deviceId: device.id, kind: 'bridge', message: `TestFlight access sync failed for ${subscription.displayName ?? subscription.url}: ${error instanceof Error ? error.message : String(error)}` });
  }
  const updated = getTestFlightSubscription(subscription.id);
  const current = updated?.devices.find((entry) => entry.deviceId === device.id);
  return current ? cloneDeviceState(current) : { deviceId: device.id, status: 'error', lastError: 'subscription state disappeared' };
}

export async function syncTestFlightSubscription(id: string, actor = 'system'): Promise<TestFlightSubscription | undefined> {
  const initial = getTestFlightSubscription(id);
  if (!initial || initial.status !== 'approved') return initial;
  ensureTestFlightSubscriptionDevices(id);
  const subscription = getTestFlightSubscription(id);
  if (!subscription) return undefined;
  const devices = [...enabledDeviceMap().values()];
  const completed: TestFlightSubscriptionDevice[] = [];
  for (let index = 0; index < devices.length; index += TESTFLIGHT_SYNC_CONCURRENCY) {
    const batch = devices.slice(index, index + TESTFLIGHT_SYNC_CONCURRENCY);
    completed.push(...await Promise.all(batch.map((device) => syncDevice(subscription, device))));
  }
  const active = completed.filter((device) => device.status === 'active').length;
  const failed = completed.length - active;
  recordTestFlightSubscriptionSync(id, actor, `${active} device(s) verified, ${failed} device(s) unavailable or unsupported`);
  const updated = getTestFlightSubscription(id);
  if (updated) {
    recordNotification({
      userId: updated.requestedBy,
      title: failed === 0 ? 'TestFlight access verified' : 'TestFlight access partially available',
      message: `${updated.displayName ?? updated.url}: ${active}/${completed.length} enabled device(s) verified.`,
      severity: failed === 0 ? 'success' : active > 0 ? 'warning' : 'error',
      href: '/?tab=settings&stab=testflight',
    });
  }
  return updated;
}

export async function unsubscribeTestFlightSubscription(id: string, actor: string): Promise<TestFlightSubscription | undefined> {
  const subscription = getTestFlightSubscription(id);
  if (!subscription) return undefined;
  if (subscription.status !== 'approved') return withdrawTestFlightSubscription(id, actor);
  const devices = enabledDeviceMap();
  const failures: string[] = [];
  for (const device of subscription.devices) {
    const record = devices.get(device.deviceId);
    if (!record) {
      const message = 'device is disabled or unavailable';
      updateTestFlightSubscriptionDevice(id, device.deviceId, { status: 'unavailable', appleMembership: 'unknown', lastSyncedAt: Date.now(), lastError: message });
      failures.push(`${device.deviceId}: ${message}`);
      continue;
    }
    const errors: string[] = [];
    if (!subscription.bundleId) {
      errors.push('TestFlight app metadata is missing');
    } else {
      try {
        await unsubscribeFromTestFlightInvite(subscription.bundleId, record, `${subscription.id}-${record.id}-unsubscribe`);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      try {
        const removed = await uninstallFromDevice(subscription.bundleId, record);
        if (!removed) errors.push('installed app could not be removed from the device');
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const lastSyncedAt = Date.now();
    if (errors.length > 0) {
      const message = errors.join('; ');
      updateTestFlightSubscriptionDevice(id, record.id, { status: 'error', appleMembership: 'unknown', lastSyncedAt, lastError: message });
      recordDeviceActivity({ deviceId: record.id, kind: 'bridge', message: `TestFlight unsubscribe cleanup failed for ${subscription.displayName ?? subscription.url}: ${message}` });
      failures.push(`${record.name}: ${message}`);
    } else {
      updateTestFlightSubscriptionDevice(id, record.id, { status: 'unsubscribed', appleMembership: 'unknown', lastSyncedAt, lastError: undefined });
    }
  }
  const detail = failures.length > 0 ? `unsubscribed with ${failures.length} device cleanup failure(s): ${failures.join(' | ')}` : subscription.url;
  const result = withdrawTestFlightSubscription(id, actor, detail);
  if (result) {
    recordNotification({
      userId: result.requestedBy,
      title: failures.length > 0 ? 'TestFlight subscription removed with warnings' : 'TestFlight subscription removed',
      message: failures.length > 0 ? `${result.displayName ?? result.url}: ${failures.join(' | ')}` : `${result.displayName ?? result.url} was removed from dkrypt automation.`,
      severity: failures.length > 0 ? 'warning' : 'success',
      href: '/?tab=settings&stab=testflight',
    });
  }
  return result;
}

export async function syncApprovedTestFlightSubscriptions(): Promise<void> {
  for (const subscription of listApprovedSubscriptions()) {
    const current = ensureTestFlightSubscriptionDevices(subscription.id) ?? subscription;
    const hasStaleDevice = current.devices.some((device) => device.status !== 'active' || !device.lastVerifiedAt || Date.now() - device.lastVerifiedAt > TESTFLIGHT_VERIFICATION_TTL_MS);
    if (hasStaleDevice) await syncTestFlightSubscription(subscription.id);
  }
}

let syncTimer: NodeJS.Timeout | undefined;

export function startTestFlightSubscriptionPoller(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => void syncApprovedTestFlightSubscriptions(), TESTFLIGHT_VERIFICATION_TTL_MS).unref();
}

export function subscriptionsForUser(userId: string, manager: boolean): TestFlightSubscription[] {
  const lower = userId.toLowerCase();
  const source = manager ? getSubscriptions() : getSubscriptions().filter((subscription) => subscription.requestedBy === lower);
  return source;
}
