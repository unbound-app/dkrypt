const CANCELLED_RE = /^cancelled by/i;
const TIMEOUT_RE = /timed? ?out/i;
const UNREACHABLE_RE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|no route to host|not reachable|connection closed/i;
const DISK_RE = /ENOSPC|no space left/i;
const APP_STORE_RE = /App Store|AppStore|appstore bridge|install.*build/i;
const TESTFLIGHT_RE = /TestFlight|testflight|beta app|train/i;
const NETWORK_RE = /fetch failed|network|HTTP [45]\d\d|socket hang up|DNS/i;
const DECRYPT_RE = /ipadecrypt|verify failed|still encrypted|cryptid/i;

export type JobFailureClass = 'device_transport' | 'app_store' | 'testflight' | 'network' | 'storage' | 'decrypt' | 'cancelled' | 'unknown';

export function classifyJobFailure(message: string | undefined): JobFailureClass {
  if (!message) return 'unknown';
  if (CANCELLED_RE.test(message)) return 'cancelled';
  if (DISK_RE.test(message)) return 'storage';
  if (DECRYPT_RE.test(message)) return 'decrypt';
  if (TESTFLIGHT_RE.test(message)) return 'testflight';
  if (APP_STORE_RE.test(message)) return 'app_store';
  if (UNREACHABLE_RE.test(message)) return 'device_transport';
  if (NETWORK_RE.test(message) || TIMEOUT_RE.test(message)) return 'network';
  return 'unknown';
}

export function categorizeFailure(message: string | undefined): string {
  if (!message) return 'Unknown';
  if (CANCELLED_RE.test(message)) return 'Cancelled';
  if (UNREACHABLE_RE.test(message)) return 'Device unreachable';
  if (DISK_RE.test(message)) return 'Disk full';
  if (TIMEOUT_RE.test(message)) return 'Timed out';
  return 'Other';
}
