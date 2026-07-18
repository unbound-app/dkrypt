import { config } from './config.js';
import { log } from './logger.js';
import { getEffectiveSettings, recordWebhookDelivery, type SchedulerSettings } from './store/state.js';
import { postJsonWithRetry } from './util/webhookRetry.js';

export type NotifyEvent =
  | 'keyRequest'
  | 'dispatchSuccess'
  | 'dispatchFailure'
  | 'appleAuthAlert'
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
  dispatchSuccess: 'notifyOnDispatchSuccess',
  dispatchFailure: 'notifyOnDispatchFailure',
  appleAuthAlert: 'notifyOnAppleAuthAlert',
  keyExpiringSoon: 'notifyOnKeyExpiringSoon',
  deviceOffline: 'notifyOnDeviceOffline',
  deviceBatteryHot: 'notifyOnDeviceBatteryHot',
  deviceBatteryLow: 'notifyOnDeviceBatteryLow',
  diskFull: 'notifyOnDiskFull',
  deviceStorageLow: 'notifyOnDeviceStorageLow',
  testFlightBridgeDown: 'notifyOnTestFlightBridgeDown',
  jobCompleted: 'notifyOnJobCompleted',
};

// Matches the dashboard's own CSS custom properties (--color-accent/ok/warn/err) so a notification
// reads as the same "app" as the dashboard, just in Discord.
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
// A rasterized copy of the app's lock-icon favicon - Discord (and most webhook receivers) don't
// reliably render SVG for author/avatar/footer images, so this points at favicon.png rather than
// favicon.svg directly.
const WEBHOOK_AVATAR_URL = `${config.publicBaseUrl}/favicon.png`;

// A flat rendering of the embed as markdown-ish plain text - `content` is read by Discord (and
// most generic JSON webhook loggers), `text` is what Slack's incoming-webhook format expects;
// sending both in one body covers all three without needing the user to pick a specific target.
function flattenEmbed(embed: NotifyEmbed): string {
  const lines = [`**${embed.title}**`];
  if (embed.description) lines.push(embed.description);
  for (const f of embed.fields ?? []) lines.push(`${f.name}: ${f.value.replace(/```/g, '')}`);
  return lines.join('\n');
}

// Discord embed limits: title 256, description 4096, field name 256, field value 1024, 25 fields max.
// `username`/`avatar_url` (Discord) and `username`/`icon_url` (Slack's incoming-webhook equivalent)
// override the webhook's default bot identity - sent on both branches so either receiver picks up
// whichever pair of keys it actually reads.
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

function targetHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

async function postWebhook(
  url: string,
  embed: NotifyEmbed,
  format: SchedulerSettings['notifyFormat'],
  event: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const result = await postJsonWithRetry(url, buildPayload(embed, format));
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

export async function notify(event: NotifyEvent, embed: NotifyEmbed): Promise<void> {
  const settings = getEffectiveSettings();
  if (!settings.notifyWebhookUrl || !settings[EVENT_SETTING_KEY[event]]) return;

  const result = await postWebhook(settings.notifyWebhookUrl, embed, settings.notifyFormat, event);
  if (!result.ok) log.warn('notify webhook failed', { event, status: result.status, error: result.error });
}

// Test sends bypass the event-toggle checks (and the delivery log, since it's not a "real"
// notification) so the Settings "Test" button always reflects the URL currently typed in,
// whether or not it's been saved yet.
export async function sendTestNotification(urlOverride?: string): Promise<{ ok: boolean; error?: string }> {
  const settings = getEffectiveSettings();
  const url = urlOverride || settings.notifyWebhookUrl;
  if (!url) return { ok: false, error: 'no webhook URL configured' };

  const result = await postJsonWithRetry(
    url,
    buildPayload(
      { title: 'Test notification', description: 'This is what a notification from dkrypt looks like.', color: EMBED_COLOR.info },
      settings.notifyFormat,
    ),
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? `webhook returned HTTP ${result.status}` };
}
