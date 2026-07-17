import { config } from './config.js';
import { log } from './logger.js';
import { getEffectiveSettings, type SchedulerSettings } from './store/state.js';

export type NotifyEvent = 'keyRequest' | 'dispatchSuccess' | 'dispatchFailure' | 'appleAuthAlert';

const EVENT_SETTING_KEY: Record<NotifyEvent, keyof SchedulerSettings> = {
  keyRequest: 'notifyOnKeyRequest',
  dispatchSuccess: 'notifyOnDispatchSuccess',
  dispatchFailure: 'notifyOnDispatchFailure',
  appleAuthAlert: 'notifyOnAppleAuthAlert',
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
function buildPayload(content: string, embed: NotifyEmbed, format: SchedulerSettings['notifyFormat']): Record<string, unknown> {
  if (format === 'plain') {
    const text = truncate(flattenEmbed(embed), 2000);
    return { content: text, text };
  }

  return {
    content: truncate(content, 2000),
    embeds: [
      {
        title: truncate(embed.title, 256),
        description: embed.description ? truncate(embed.description, 4096) : undefined,
        color: embed.color,
        fields: embed.fields
          ?.slice(0, 25)
          .map((f) => ({ name: truncate(f.name, 256), value: truncate(f.value, 1024), inline: f.inline })),
        footer: { text: 'dkrypt', icon_url: `${config.publicBaseUrl}/og-image.png` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function postWebhook(
  url: string,
  content: string,
  embed: NotifyEmbed,
  format: SchedulerSettings['notifyFormat'],
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(content, embed, format)),
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function notify(event: NotifyEvent, content: string, embed: NotifyEmbed): Promise<void> {
  const settings = getEffectiveSettings();
  if (!settings.notifyWebhookUrl || !settings[EVENT_SETTING_KEY[event]]) return;

  const result = await postWebhook(settings.notifyWebhookUrl, content, embed, settings.notifyFormat);
  if (!result.ok) log.warn('notify webhook failed', { event, status: result.status, error: result.error });
}

export async function sendTestNotification(urlOverride?: string): Promise<{ ok: boolean; error?: string }> {
  const settings = getEffectiveSettings();
  const url = urlOverride || settings.notifyWebhookUrl;
  if (!url) return { ok: false, error: 'no webhook URL configured' };

  const result = await postWebhook(
    url,
    '🔔 Test notification',
    {
      title: 'Test notification',
      description: 'This is what a notification from dkrypt looks like.',
      color: EMBED_COLOR.info,
    },
    settings.notifyFormat,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? `webhook returned HTTP ${result.status}` };
}
