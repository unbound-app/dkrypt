export function isValidTimeZone(timezone: string): boolean {
  if (!timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function systemTimeZone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone && isValidTimeZone(timezone) ? timezone : 'UTC';
}

export function effectiveTimeZone(timezone?: string): string {
  return timezone && isValidTimeZone(timezone) ? timezone : systemTimeZone();
}
