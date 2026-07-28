import { config } from '#config.js';
import { createHmac } from 'node:crypto';
import { log } from '#logger.js';
import { sendMailToAllSubscribed, type MailCategory } from '#mail.js';
import { sendPushToAllSubscribed, type PushCategory } from '#push.js';
import { getEffectiveSettings, recordWebhookDelivery, type SchedulerSettings } from '#store/state.js';
import { postJsonWithRetry } from '#util/webhookRetry.js';

export type NotifyEvent =
  | 'keyRequest'
  | 'appStoreAutomationSuccess'
  | 'testFlightAutomationSuccess'
  | 'appStoreAutomationFailure'
  | 'testFlightAutomationFailure'
  | 'keyExpiringSoon'
  | 'deviceOffline'
  | 'deviceBatteryHot'
  | 'deviceBatteryLow'
  | 'diskFull'
  | 'deviceStorageLow'
  | 'testFlightBridgeDown'
  | 'jobCompleted';

const EVENT_SETTING_KEY: Record<NotifyEvent, keyof SchedulerSettings> = {
  keyRequest: 'notifyOnKeyRequest',
  appStoreAutomationSuccess: 'notifyOnAutomationSuccess',
  testFlightAutomationSuccess: 'notifyOnAutomationSuccess',
  appStoreAutomationFailure: 'notifyOnAutomationFailure',
  testFlightAutomationFailure: 'notifyOnAutomationFailure',
  keyExpiringSoon: 'notifyOnKeyExpiringSoon',
  deviceOffline: 'notifyOnDeviceOffline',
  deviceBatteryHot: 'notifyOnDeviceBatteryHot',
  deviceBatteryLow: 'notifyOnDeviceBatteryLow',
  diskFull: 'notifyOnDiskFull',
  deviceStorageLow: 'notifyOnDeviceStorageLow',
  testFlightBridgeDown: 'notifyOnTestFlightBridgeDown',
  jobCompleted: 'notifyOnJobCompleted',
};

export const EMBED_COLOR = {
  info: 0x5b8cff,
  ok: 0x3ecf8e,
  warn: 0xf5a623,
  err: 0xf2545b,
} as const;

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface NotifyEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: EmbedField[];
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const WEBHOOK_USERNAME = 'dkrypt';

const WEBHOOK_AVATAR_URL = `${config.publicBaseUrl}/favicon.png`;

interface PendingDigest {
  url: string;
  format: SchedulerSettings['notifyFormat'];
  entries: string[];
}

const pendingDigests = new Map<string, PendingDigest>();
let lastDigestKey: string | undefined;

function flattenEmbed(embed: NotifyEmbed): string {
  const lines = [`**${embed.title}**`];
  if (embed.description) lines.push(embed.description);
  for (const f of embed.fields ?? []) lines.push(`${f.name}: ${f.value.replace(/```/g, '')}`);
  return lines.join('\n');
}

function buildPayload(embed: NotifyEmbed, format: SchedulerSettings['notifyFormat']): Record<string, unknown> {
  if (format === 'plain') {
    const text = truncate(flattenEmbed(embed), 2000);
    return { content: text, text, username: WEBHOOK_USERNAME, icon_url: WEBHOOK_AVATAR_URL };
  }

  return {
    username: WEBHOOK_USERNAME,
    avatar_url: WEBHOOK_AVATAR_URL,
    embeds: [
      {
        title: truncate(embed.title, 256),
        description: embed.description ? truncate(embed.description, 4096) : undefined,
        color: embed.color,
        fields: embed.fields
          ?.slice(0, 25)
          .map((f) => ({ name: truncate(f.name, 256), value: truncate(f.value, 1024), inline: f.inline })),
        footer: { text: 'dkrypt', icon_url: WEBHOOK_AVATAR_URL },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export function webhookSignature(secret: string, timestamp: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;
}

function webhookHeaders(event: string, payload: Record<string, unknown>): Record<string, string> {
  if (!config.outboundWebhookSecret) return {};
  const timestamp = new Date().toISOString();
  const body = JSON.stringify(payload);
  return {
    'X-Dkrypt-Event': event,
    'X-Dkrypt-Timestamp': timestamp,
    'X-Dkrypt-Signature': webhookSignature(config.outboundWebhookSecret, timestamp, body),
  };
}

function targetHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function isWithinQuietHours(now: Date, start: string, end: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;
  return startMinutes < endMinutes ? current >= startMinutes && current < endMinutes : current >= startMinutes || current < endMinutes;
}

function isSuccessNotification(event: NotifyEvent, embed: NotifyEmbed): boolean {
  return event === 'appStoreAutomationSuccess' || event === 'testFlightAutomationSuccess' || (event === 'jobCompleted' && embed.color === EMBED_COLOR.ok);
}

function queueDigest(url: string, format: SchedulerSettings['notifyFormat'], embed: NotifyEmbed): void {
  const key = `${url}|${format}`;
  const digest = pendingDigests.get(key) ?? { url, format, entries: [] };
  digest.entries.push(flattenEmbed(embed));
  pendingDigests.set(key, digest);
}

function digestKey(mode: SchedulerSettings['notifySuccessMode'], now: Date): string | undefined {
  if (mode === 'instant') return undefined;
  if (now.getHours() !== 9) return undefined;
  if (mode === 'daily') return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (now.getDay() !== 1) return undefined;
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-weekly`;
}

async function postWebhook(
  url: string,
  embed: NotifyEmbed,
  format: SchedulerSettings['notifyFormat'],
  event: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const payload = buildPayload(embed, format);
  const result = await postJsonWithRetry(url, payload, webhookHeaders(event, payload));
  recordWebhookDelivery({
    kind: event === 'jobCompleted' ? 'job' : 'scheduler',
    event,
    targetHost: targetHost(url),
    ok: result.ok,
    status: result.status,
    error: result.error,
    durationMs: result.durationMs,
  });
  return result;
}

const PUSH_EVENT_CATEGORY: Partial<Record<NotifyEvent, PushCategory>> = {
  keyExpiringSoon: 'keyExpiry',
  deviceOffline: 'deviceAlert',
  deviceBatteryHot: 'deviceAlert',
  deviceBatteryLow: 'deviceAlert',
  diskFull: 'deviceAlert',
  deviceStorageLow: 'deviceAlert',
  testFlightBridgeDown: 'deviceAlert',
};

const MAIL_EVENT_CATEGORY: Partial<Record<NotifyEvent, MailCategory>> = {
  keyExpiringSoon: 'keyExpiry',
  deviceOffline: 'deviceAlert',
  deviceBatteryHot: 'deviceAlert',
  deviceBatteryLow: 'deviceAlert',
  diskFull: 'deviceAlert',
  deviceStorageLow: 'deviceAlert',
  testFlightBridgeDown: 'deviceAlert',
};

export async function notify(event: NotifyEvent, embed: NotifyEmbed, webhookUrlOverride?: string): Promise<void> {
  const settings = getEffectiveSettings();
  if (!settings[EVENT_SETTING_KEY[event]]) return;

  const pushCategory = PUSH_EVENT_CATEGORY[event];
  if (pushCategory) {
    void sendPushToAllSubscribed({ title: embed.title, body: embed.description ?? embed.title }, pushCategory);
  }

  const mailCategory = MAIL_EVENT_CATEGORY[event];
  if (mailCategory) {
    void sendMailToAllSubscribed({ subject: embed.title, text: embed.description ?? embed.title }, mailCategory);
  }

  const url = webhookUrlOverride || settings.notifyWebhookUrl;
  if (!url) return;
  if (isSuccessNotification(event, embed)) {
    if (isWithinQuietHours(new Date(), settings.notifyQuietHoursStart, settings.notifyQuietHoursEnd)) {
      if (settings.notifySuccessMode !== 'instant') queueDigest(url, settings.notifyFormat, embed);
      return;
    }
    if (settings.notifySuccessMode !== 'instant') {
      queueDigest(url, settings.notifyFormat, embed);
      return;
    }
  }
  const result = await postWebhook(url, embed, settings.notifyFormat, event);
  if (!result.ok) log.warn('notify webhook failed', { event, status: result.status, error: result.error });
}

export async function flushNotificationDigests(now = new Date()): Promise<void> {
  const settings = getEffectiveSettings();
  const key = digestKey(settings.notifySuccessMode, now);
  if (!key || key === lastDigestKey || pendingDigests.size === 0) return;
  lastDigestKey = key;
  const digests = [...pendingDigests.values()];
  pendingDigests.clear();
  await Promise.all(
    digests.map(async (digest) => {
      const embed: NotifyEmbed = {
        title: settings.notifySuccessMode === 'weekly' ? 'Weekly dkrypt automation digest' : 'Daily dkrypt automation digest',
        description: digest.entries.slice(-20).join('\n\n'),
        color: EMBED_COLOR.ok,
      };
      const result = await postWebhook(digest.url, embed, digest.format, 'automationDigest');
      if (!result.ok) log.warn('notification digest webhook failed', { status: result.status, error: result.error });
    }),
  );
}

export function startNotificationDigestScheduler(): void {
  setInterval(() => void flushNotificationDigests(), 60_000).unref();
}

export async function sendTestNotification(urlOverride?: string): Promise<{ ok: boolean; error?: string }> {
  const settings = getEffectiveSettings();
  const url = urlOverride || settings.notifyWebhookUrl;
  if (!url) return { ok: false, error: 'no webhook URL configured' };

  const payload = buildPayload(
    { title: 'Test notification', description: 'This is what a notification from dkrypt looks like.', color: EMBED_COLOR.info },
    settings.notifyFormat,
  );
  const result = await postJsonWithRetry(url, payload, webhookHeaders('testNotification', payload));
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? `webhook returned HTTP ${result.status}` };
}
