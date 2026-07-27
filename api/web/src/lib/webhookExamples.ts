import type { SchedulerSettings } from '#lib/api';

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface ExampleEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: EmbedField[];
}

const COLOR = { info: 0x5b8cff, ok: 0x3ecf8e, warn: 0xf5a623, err: 0xf2545b };

const EXAMPLES: Record<keyof SchedulerSettings & `notifyOn${string}`, ExampleEmbed> = {
  notifyOnJobCompleted: {
    title: 'Decrypt finished',
    color: COLOR.ok,
    fields: [
      { name: 'App', value: 'Example App (com.example.app)', inline: true },
      { name: 'Trigger', value: 'manual', inline: true },
      { name: 'Channel', value: 'App Store', inline: true },
      { name: 'Size', value: '184.3 MB', inline: true },
    ],
  },
  notifyOnKeyRequest: {
    title: 'New API key request',
    description: '**alice** requested a new key ("ci-runner") - approve it on the API Keys tab.',
    color: COLOR.info,
  },
  notifyOnAutomationSuccess: {
    title: 'Automation succeeded',
    color: COLOR.ok,
    fields: [
      { name: 'App', value: 'Example App (com.example.app)' },
      { name: 'Channel', value: 'TestFlight', inline: true },
      { name: 'Stage', value: 'workflow run', inline: true },
      { name: 'Run', value: 'https://github.com/owner/repo/actions/runs/123456' },
    ],
  },
  notifyOnAutomationFailure: {
    title: 'Automation needs attention',
    color: COLOR.err,
    fields: [
      { name: 'App', value: 'Example App (com.example.app)' },
      { name: 'Channel', value: 'TestFlight', inline: true },
      { name: 'Stage', value: 'metadata check', inline: true },
      { name: 'Reason', value: 'autoinstall completed but decrypt timed out' },
    ],
  },
  notifyOnKeyExpiringSoon: {
    title: 'API key expiring soon',
    description: '**ci-runner** (owned by **alice**) expires **2026-08-01T00:00:00.000Z** - regenerate or extend it before it stops working.',
    color: COLOR.warn,
  },
  notifyOnDeviceOffline: {
    title: 'iDevice unreachable',
    description: "homelab has been unreachable for at least 15 minutes - decrypts assigned to it can't run until it's back.",
    color: COLOR.err,
  },
  notifyOnDeviceBatteryHot: {
    title: 'iDevice running hot',
    description: "homelab's battery temperature reached 43.2°C (alert threshold 42°C).",
    color: COLOR.warn,
  },
  notifyOnDeviceBatteryLow: {
    title: 'iDevice battery low',
    description: "homelab's battery is at 15% and not charging (alert threshold 20%).",
    color: COLOR.warn,
  },
  notifyOnDiskFull: {
    title: 'Staging disk running low',
    description: '/data/tmp is 92% full (alert threshold 90%) - decrypts will start failing once it fills up.',
    color: COLOR.warn,
  },
  notifyOnDeviceStorageLow: {
    title: 'iDevice storage running low',
    description: "homelab's storage is 91% full (alert threshold 90%) - decrypts and TestFlight installs need room to work in.",
    color: COLOR.warn,
  },
  notifyOnTestFlightBridgeDown: {
    title: 'Autoinstall bridge unresponsive',
    description:
      'The autoinstall SpringBoard bridge on homelab has stopped responding for at least 15 minutes - App Store/TestFlight automation cannot install until it recovers.',
    color: COLOR.warn,
  },
};

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function flattenEmbed(embed: ExampleEmbed): string {
  const lines = [`**${embed.title}**`];
  if (embed.description) lines.push(embed.description);
  for (const f of embed.fields ?? []) lines.push(`${f.name}: ${f.value.replace(/```/g, '')}`);
  return lines.join('\n');
}

export function exampleWebhookPayload(eventKey: keyof SchedulerSettings, format: SchedulerSettings['notifyFormat']): string {
  const embed = EXAMPLES[eventKey as keyof typeof EXAMPLES];
  if (!embed) return '{}';

  if (format === 'plain') {
    const text = truncate(flattenEmbed(embed), 2000);
    return JSON.stringify({ content: text, text, username: 'dkrypt', icon_url: '<PUBLIC_BASE_URL>/favicon.png' }, null, 2);
  }

  return JSON.stringify(
    {
      username: 'dkrypt',
      avatar_url: '<PUBLIC_BASE_URL>/favicon.png',
      embeds: [
        {
          title: truncate(embed.title, 256),
          description: embed.description ? truncate(embed.description, 4096) : undefined,
          color: embed.color,
          fields: embed.fields?.slice(0, 25),
          footer: { text: 'dkrypt', icon_url: '<PUBLIC_BASE_URL>/favicon.png' },
          timestamp: '<ISO timestamp>',
        },
      ],
    },
    null,
    2,
  );
}
