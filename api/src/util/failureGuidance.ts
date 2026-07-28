import { categorizeFailure } from '#util/failureCategory.js';

export interface FailureGuidance {
  category: string;
  title: string;
  action: string;
  retryRecommended: boolean;
}

export function getFailureGuidance(message: string | undefined): FailureGuidance {
  const category = categorizeFailure(message);
  if (category === 'Cancelled') return { category, title: 'Job was cancelled', action: 'Queue the decrypt again when you are ready.', retryRecommended: true };
  if (category === 'Device unreachable') return { category, title: 'Device connection failed', action: 'Run a device preflight, restore SSH or network access, then retry.', retryRecommended: true };
  if (category === 'Disk full') return { category, title: 'Storage is exhausted', action: 'Free storage on the device or host, then retry.', retryRecommended: true };
  if (category === 'Timed out') return { category, title: 'The operation timed out', action: 'Check the job timeline and bridge diagnostics before retrying.', retryRecommended: true };
  if (/bridge|autoinstall|app store|testflight/i.test(message ?? '')) return { category: 'Bridge error', title: 'The on-device bridge needs attention', action: 'Run a device preflight and relaunch the affected store app before retrying.', retryRecommended: true };
  return { category, title: 'The decrypt did not complete', action: 'Download the diagnostic bundle, check the job timeline, then retry if the underlying issue is resolved.', retryRecommended: true };
}
