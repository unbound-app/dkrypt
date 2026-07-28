const CANCELLED_RE = /^cancelled by/i;
const TIMEOUT_RE = /timed? ?out/i;
const UNREACHABLE_RE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|no route to host|not reachable|connection closed/i;
const DISK_RE = /ENOSPC|no space left/i;

export function categorizeFailure(message: string | undefined): string {
  if (!message) return 'Unknown';
  if (CANCELLED_RE.test(message)) return 'Cancelled';
  if (UNREACHABLE_RE.test(message)) return 'Device unreachable';
  if (DISK_RE.test(message)) return 'Disk full';
  if (TIMEOUT_RE.test(message)) return 'Timed out';
  return 'Other';
}
