import { dashboardEvents } from './events.js';
import { scopedLogger } from './logger.js';
import { getEffectiveSettings, recordWebhookDelivery, type JobHistoryEntry } from './store/state.js';
import { postJsonWithRetry } from './util/webhookRetry.js';

const log = scopedLogger('jobWebhook');

function targetHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

async function dispatch(entry: JobHistoryEntry): Promise<void> {
  const settings = getEffectiveSettings();
  if (!settings.jobWebhookEnabled || !settings.jobWebhookUrl) return;

  const result = await postJsonWithRetry(settings.jobWebhookUrl, { event: 'job.completed', job: entry });
  recordWebhookDelivery({
    kind: 'job',
    event: 'job.completed',
    targetHost: targetHost(settings.jobWebhookUrl),
    ok: result.ok,
    status: result.status,
    error: result.error,
    durationMs: result.durationMs,
  });
  if (!result.ok) log.warn('job completion webhook failed', { jobId: entry.id, status: result.status, error: result.error });
}

// historyAdded already fires exactly once per finished job (manual/scheduler/TestFlight,
// done/failed, even cancellations) from recordJobHistory() - listening here rather than calling
// into jobs/store.ts directly keeps state.ts's "pure persistence + emit" boundary intact.
export function startJobWebhookDispatcher(): void {
  dashboardEvents.on('historyAdded', (entry: JobHistoryEntry) => void dispatch(entry));
}
