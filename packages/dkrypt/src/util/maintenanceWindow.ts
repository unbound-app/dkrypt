import { nextCronRunAt } from '#util/cron.js';

export interface MaintenanceWindow {
  start: string;
  end: string;
}

export interface RunnableCronOccurrence {
  at: number;
  deferred: boolean;
}

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const CLOCK_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MINUTE_MS = 60_000;
const MAX_LOCAL_GAP_MINUTES = 26 * 60;

function minutesOfDay(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function readLocalDateTime(timestamp: number, formatter: Intl.DateTimeFormat): LocalDateTime {
  const parts = formatter.formatToParts(new Date(timestamp));
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') };
}

function localDateKey(value: Pick<LocalDateTime, 'year' | 'month' | 'day'>): string {
  return `${value.year.toString().padStart(4, '0')}-${value.month.toString().padStart(2, '0')}-${value.day.toString().padStart(2, '0')}`;
}

function addCalendarDay(value: Pick<LocalDateTime, 'year' | 'month' | 'day'>): Pick<LocalDateTime, 'year' | 'month' | 'day'> {
  const next = new Date(Date.UTC(value.year, value.month - 1, value.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function isValidMaintenanceWindow(value: unknown): value is MaintenanceWindow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.start === 'string'
    && typeof candidate.end === 'string'
    && CLOCK_TIME_PATTERN.test(candidate.start)
    && CLOCK_TIME_PATTERN.test(candidate.end)
    && candidate.start !== candidate.end;
}

export function isWithinMaintenanceWindow(window: MaintenanceWindow | undefined, timezone: string, timestamp = Date.now()): boolean {
  if (!window || !isValidMaintenanceWindow(window)) return false;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const current = readLocalDateTime(timestamp, formatter);
    const currentMinute = current.hour * 60 + current.minute;
    const startMinute = minutesOfDay(window.start);
    const endMinute = minutesOfDay(window.end);
    return startMinute < endMinute
      ? currentMinute >= startMinute && currentMinute < endMinute
      : currentMinute >= startMinute || currentMinute < endMinute;
  } catch {
    return false;
  }
}

function resolveLocalMinuteAtOrAfter(
  targetDate: Pick<LocalDateTime, 'year' | 'month' | 'day'>,
  targetMinute: number,
  timezone: string,
  afterAt: number,
): number | undefined {
  const targetHour = Math.floor(targetMinute / 60);
  const targetMinutePart = targetMinute % 60;
  const targetWallTime = Date.UTC(targetDate.year, targetDate.month - 1, targetDate.day, targetHour, targetMinutePart);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const offsets = new Set<number>();
  for (const shift of [-48, -24, -6, 6, 24, 48]) {
    const sampleAt = targetWallTime + shift * 60 * 60 * 1000;
    const local = readLocalDateTime(sampleAt, formatter);
    const localWallTime = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    offsets.add(localWallTime - Math.floor(sampleAt / MINUTE_MS) * MINUTE_MS);
  }

  for (let shift = 0; shift <= MAX_LOCAL_GAP_MINUTES; shift++) {
    const localWallTime = targetWallTime + shift * MINUTE_MS;
    const expected = new Date(localWallTime);
    const expectedDateKey = localDateKey({ year: expected.getUTCFullYear(), month: expected.getUTCMonth() + 1, day: expected.getUTCDate() });
    let earliest: number | undefined;
    for (const offset of offsets) {
      const candidateAt = localWallTime - offset;
      if (candidateAt <= afterAt) continue;
      const local = readLocalDateTime(candidateAt, formatter);
      if (localDateKey(local) !== expectedDateKey || local.hour !== expected.getUTCHours() || local.minute !== expected.getUTCMinutes()) continue;
      earliest = earliest === undefined ? candidateAt : Math.min(earliest, candidateAt);
    }
    if (earliest !== undefined) return earliest;
  }
  return undefined;
}

export function maintenanceWindowEndAt(window: MaintenanceWindow | undefined, timezone: string, timestamp = Date.now()): number | undefined {
  if (!window || !isWithinMaintenanceWindow(window, timezone, timestamp)) return undefined;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const current = readLocalDateTime(timestamp, formatter);
    const currentMinute = current.hour * 60 + current.minute;
    const startMinute = minutesOfDay(window.start);
    const endMinute = minutesOfDay(window.end);
    const targetDate = startMinute > endMinute && currentMinute >= startMinute ? addCalendarDay(current) : current;
    return resolveLocalMinuteAtOrAfter(targetDate, endMinute, timezone, timestamp);
  } catch {
    return undefined;
  }
}

export function nextRunnableCronOccurrence(
  expression: string,
  timezone: string,
  window: MaintenanceWindow | undefined,
  fromAt: number,
  untilAt: number,
): RunnableCronOccurrence | undefined {
  const scheduledAt = nextCronRunAt(expression, timezone, fromAt);
  if (scheduledAt === undefined || scheduledAt > untilAt) return undefined;
  if (!isWithinMaintenanceWindow(window, timezone, scheduledAt)) return { at: scheduledAt, deferred: false };
  const deferredUntil = maintenanceWindowEndAt(window, timezone, scheduledAt);
  if (deferredUntil === undefined) return undefined;
  return deferredUntil <= untilAt ? { at: deferredUntil, deferred: true } : undefined;
}
