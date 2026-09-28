function formatNumber(value: number, locale?: string, maximumFractionDigits = 1, minimumFractionDigits = 0): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits, minimumFractionDigits }).format(value);
}

function isGerman(locale?: string): boolean {
  return locale?.toLowerCase().startsWith('de') ?? false;
}

export function fmtNumber(value: number, locale?: string, maximumFractionDigits = 1, minimumFractionDigits = 0): string {
  return formatNumber(value, locale, maximumFractionDigits, minimumFractionDigits);
}

export function fmtTime(ms?: number, locale?: string): string {
  if (ms === undefined || !Number.isFinite(ms) || ms === 0) return '-';
  return fmtDateTime(ms, {}, locale);
}

export function fmtDateTime(value: number | string, options: Intl.DateTimeFormatOptions = {}, locale?: string): string {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) return '-';
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...options,
  }).format(new Date(timestamp));
}

export function fmtCalendarDate(value: number | string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }, locale?: string): string {
  const isDateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const timestamp = typeof value === 'number'
    ? value
    : Date.parse(isDateOnly ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(timestamp)) return '-';
  const timeZone = options.timeZone ?? (isDateOnly ? 'UTC' : undefined);
  return new Intl.DateTimeFormat(locale, {
    ...options,
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(timestamp));
}

export function fmtRelative(ms?: number, locale?: string): string {
  if (!ms) return '-';
  const diff = ms - Date.now();
  const future = diff > 0;
  const sec = Math.round(Math.abs(diff) / 1000);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (sec < 45) return relative.format(future ? 1 : 0, 'second');
  const min = Math.round(sec / 60);
  if (min < 60) return relative.format(future ? min : -min, 'minute');
  const hr = Math.round(min / 60);
  if (hr < 24) return relative.format(future ? hr : -hr, 'hour');
  const day = Math.round(hr / 24);
  if (day < 30) return relative.format(future ? day : -day, 'day');
  return fmtCalendarDate(ms, { dateStyle: 'medium' }, locale);
}

export function fmtSize(bytes?: number, locale?: string): string {
  if (!bytes) return '-';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${formatNumber(mb, locale, 1, 1)} MB` : `${formatNumber(bytes / 1024, locale, 0)} KB`;
}

export function fmtDurationApprox(ms: number, locale?: string): string {
  const min = ms / 60_000;
  if (min < 1) return isGerman(locale) ? '<1 Min.' : '<1m';
  if (min < 60) return isGerman(locale) ? `~${formatNumber(Math.round(min), locale, 0)} Min.` : `~${formatNumber(Math.round(min), locale, 0)}m`;
  return isGerman(locale) ? `~${formatNumber(min / 60, locale, 1, 1)} Std.` : `~${formatNumber(min / 60, locale, 1, 1)}h`;
}

export function fmtUntil(ms?: number, locale?: string): string {
  if (!ms) return '-';
  const diff = ms - Date.now();
  if (diff <= 0) return isGerman(locale) ? 'abgelaufen' : 'expired';
  const min = Math.round(diff / 60_000);
  if (min < 60) return isGerman(locale) ? `${formatNumber(min, locale, 0)} Min.` : `${formatNumber(min, locale, 0)}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return isGerman(locale) ? `${formatNumber(hr, locale, 0)} Std.` : `${formatNumber(hr, locale, 0)}h`;
  const day = Math.round(hr / 24);
  if (!isGerman(locale)) return `${formatNumber(day, locale, 0)}d`;
  return day === 1 ? '1 Tag' : `${formatNumber(day, locale, 0)} Tage`;
}

export function fmtBytesGB(bytes: number, locale?: string): string {
  return `${formatNumber(bytes / 1024 ** 3, locale, 1, 1)} GB`;
}

export function fmtCurrency(amount: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
}

export function fmtCountdown(ms: number, locale?: string): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const formattedHours = formatNumber(h, locale, 0);
  const formattedMinutes = formatNumber(m, locale, 0);
  const formattedSeconds = formatNumber(s, locale, 0);
  if (isGerman(locale)) {
    if (h > 0) return `${formattedHours} Std. ${formattedMinutes} Min.`;
    if (m > 0) return `${formattedMinutes} Min. ${formattedSeconds} Sek.`;
    return `${formattedSeconds} Sek.`;
  }
  if (h > 0) return `${formattedHours}h ${formattedMinutes}m`;
  if (m > 0) return `${formattedMinutes}m ${formattedSeconds}s`;
  return `${formattedSeconds}s`;
}

export function downloadBlob(content: string, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function csvCell(value: unknown): string {
  const str = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function trendDelta(values: number[]): number | null {
  if (values.length < 4) return null;
  const mid = Math.floor(values.length / 2);
  const first = values.slice(0, mid);
  const second = values.slice(mid);
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const firstAvg = avg(first);
  const secondAvg = avg(second);
  if (firstAvg === 0) return secondAvg > 0 ? null : 0;
  return Math.round(((secondAvg - firstAvg) / firstAvg) * 100);
}

export function debounce<Args extends unknown[]>(fn: (...args: Args) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: Args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
