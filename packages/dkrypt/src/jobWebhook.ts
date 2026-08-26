import { dashboardEvents } from '#events.js';
import { EMBED_COLOR, notify } from '#notify.js';
import { recordNotification, type JobHistoryEntry } from '#store/state.js';
import { artifactFileAvailable, getArtifactById } from '#artifacts.js';

function label(entry: JobHistoryEntry): string {
  return entry.versionLabel ? `${entry.bundleId} (${entry.versionLabel})` : entry.bundleId;
}

function fmtBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

export function startJobWebhookDispatcher(): void {
  dashboardEvents.on('historyAdded', (entry: JobHistoryEntry) => {
    const labelText = label(entry);
    const artifact = entry.artifactId ? getArtifactById(entry.artifactId) : undefined;
    const hasArtifact = artifactFileAvailable(artifact);
    const completionMessage = hasArtifact
      ? `${labelText} is ready to download.`
      : `${labelText} finished, but its artifact is unavailable.`;
    recordNotification({
      userId: entry.queuedBy ?? 'root',
      title: entry.status === 'done' ? 'Decrypt finished' : 'Decrypt failed',
      message: entry.status === 'done' ? completionMessage : `${labelText}: ${entry.error ?? 'the decrypt failed'}`,
      severity: entry.status === 'done' ? hasArtifact ? 'success' : 'warning' : 'error',
      jobId: entry.id,
      href: `/?tab=home&job=${encodeURIComponent(entry.id)}`,
    });
    void notify('jobCompleted', {
      title: entry.status === 'done' ? 'Decrypt finished' : 'Decrypt failed',
      color: entry.status === 'done' ? hasArtifact ? EMBED_COLOR.ok : EMBED_COLOR.warn : EMBED_COLOR.err,
      fields: [
        { name: 'App', value: label(entry), inline: true },
        { name: 'Source', value: entry.source, inline: true },
        ...(entry.status === 'done' && entry.sizeBytes ? [{ name: 'Size', value: fmtBytes(entry.sizeBytes), inline: true }] : []),
        ...(entry.status === 'failed' && entry.error ? [{ name: 'Error', value: `\`\`\`${entry.error}\`\`\`` }] : []),
      ],
    });
  });
}
