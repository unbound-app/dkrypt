import { dashboardEvents } from '#events.js';
import { EMBED_COLOR, notify } from '#notify.js';
import { type JobHistoryEntry } from '#store/state.js';

function label(entry: JobHistoryEntry): string {
  return entry.versionLabel ? `${entry.bundleId} (${entry.versionLabel})` : entry.bundleId;
}

function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

export function startJobWebhookDispatcher(): void {
  dashboardEvents.on('historyAdded', (entry: JobHistoryEntry) => {
    void notify('jobCompleted', {
      title: entry.status === 'done' ? 'Decrypt finished' : 'Decrypt failed',
      color: entry.status === 'done' ? EMBED_COLOR.ok : EMBED_COLOR.err,
      fields: [
        { name: 'App', value: label(entry), inline: true },
        { name: 'Source', value: entry.source, inline: true },
        ...(entry.status === 'done' && entry.sizeBytes ? [{ name: 'Size', value: fmtBytes(entry.sizeBytes), inline: true }] : []),
        ...(entry.status === 'failed' && entry.error ? [{ name: 'Error', value: `\`\`\`${entry.error}\`\`\`` }] : []),
      ],
    });
  });
}
