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

let historyListener: ((entry: JobHistoryEntry) => void) | undefined;

export function startJobWebhookDispatcher(): void {
  if (historyListener) return;
  historyListener = (entry: JobHistoryEntry) => {
    const labelText = label(entry);
    const artifact = entry.artifactId ? getArtifactById(entry.artifactId) : undefined;
    const hasArtifact = artifactFileAvailable(artifact);
    const hasWarnings = entry.status === 'done' && (entry.warnings?.length ?? 0) > 0;
    const completionMessage = hasArtifact
      ? `${labelText} is ready to download.`
      : `${labelText} finished, but its artifact is unavailable.`;
    const warningMessage = hasWarnings ? ` Completed with warnings: ${entry.warnings?.join(' ')}` : '';
    recordNotification({
      userId: entry.queuedBy ?? 'root',
      title: entry.status === 'done'
        ? hasWarnings ? 'Decrypt finished with warnings' : 'Decrypt finished'
        : 'Decrypt failed',
      message: entry.status === 'done' ? `${completionMessage}${warningMessage}` : `${labelText}: ${entry.error ?? 'the decrypt failed'}`,
      severity: entry.status === 'done' ? hasWarnings ? 'warning' : hasArtifact ? 'success' : 'warning' : 'error',
      jobId: entry.id,
      href: `/?tab=home&job=${encodeURIComponent(entry.id)}`,
    });
    void notify('jobCompleted', {
      title: entry.status === 'done'
        ? hasWarnings ? 'Decrypt finished with warnings' : 'Decrypt finished'
        : 'Decrypt failed',
      color: entry.status === 'done' ? hasWarnings ? EMBED_COLOR.warn : hasArtifact ? EMBED_COLOR.ok : EMBED_COLOR.warn : EMBED_COLOR.err,
      fields: [
        { name: 'App', value: label(entry), inline: true },
        { name: 'Source', value: entry.source, inline: true },
        ...(entry.status === 'done' && entry.sizeBytes ? [{ name: 'Size', value: fmtBytes(entry.sizeBytes), inline: true }] : []),
        ...(hasWarnings ? [{ name: 'Warnings', value: entry.warnings?.join('\n') ?? '' }] : []),
        ...(entry.status === 'failed' && entry.error ? [{ name: 'Error', value: `\`\`\`${entry.error}\`\`\`` }] : []),
      ],
    });
  };
  dashboardEvents.on('historyAdded', historyListener);
}

export function stopJobWebhookDispatcher(): void {
  if (!historyListener) return;
  dashboardEvents.off('historyAdded', historyListener);
  historyListener = undefined;
}
