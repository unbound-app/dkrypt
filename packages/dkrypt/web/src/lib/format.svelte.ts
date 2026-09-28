import {
  fmtBytesGB as formatBytesGB,
  fmtCalendarDate as formatCalendarDate,
  fmtCountdown as formatCountdown,
  fmtCurrency as formatCurrency,
  fmtDateTime as formatDateTime,
  fmtDurationApprox as formatDurationApprox,
  fmtNumber as formatLocalizedNumber,
  fmtRelative as formatRelative,
  fmtSize as formatSize,
  fmtTime as formatTime,
  fmtUntil as formatUntil,
  csvCell,
  debounce,
  downloadBlob,
  trendDelta,
} from './format';
import { resolveLocaleTag } from './locale';
import { formattingLocaleState, systemLocalesState } from './ui.svelte';

function activeLocale(): string {
  return resolveLocaleTag(formattingLocaleState.value, systemLocalesState.value);
}

export { csvCell, debounce, downloadBlob, trendDelta };

export function fmtTime(ms?: number): string {
  return formatTime(ms, activeLocale());
}

export function fmtDateTime(value: number | string, options: Intl.DateTimeFormatOptions = {}): string {
  return formatDateTime(value, options, activeLocale());
}

export function fmtCalendarDate(value: number | string, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  return formatCalendarDate(value, options, activeLocale());
}

export function fmtRelative(ms?: number): string {
  return formatRelative(ms, activeLocale());
}

export function fmtSize(bytes?: number): string {
  return formatSize(bytes, activeLocale());
}

export function fmtDurationApprox(ms: number): string {
  return formatDurationApprox(ms, activeLocale());
}

export function fmtUntil(ms?: number): string {
  return formatUntil(ms, activeLocale());
}

export function fmtBytesGB(bytes: number): string {
  return formatBytesGB(bytes, activeLocale());
}

export function fmtCountdown(ms: number): string {
  return formatCountdown(ms, activeLocale());
}

export function fmtCurrency(amount: number, currency: string): string {
  return formatCurrency(amount, currency, activeLocale());
}

export function fmtNumber(value: number, maximumFractionDigits = 1, minimumFractionDigits = 0): string {
  return formatLocalizedNumber(value, activeLocale(), maximumFractionDigits, minimumFractionDigits);
}
