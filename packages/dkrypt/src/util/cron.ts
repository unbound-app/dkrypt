import { CronExpressionParser } from 'cron-parser';

export function nextCronRunAt(expr: string, timezone?: string, fromAt = Date.now()): number | undefined {
  if (!expr.trim()) return undefined;
  try {
    return CronExpressionParser.parse(expr, { tz: timezone, currentDate: new Date(fromAt) }).next().getTime();
  } catch {
    return undefined;
  }
}

export function nextMissedCronRunAt(expr: string, timezone: string, lastRunAt: number, nowAt: number): number | undefined {
  const next = nextCronRunAt(expr, timezone, lastRunAt);
  return next !== undefined && next <= nowAt ? next : undefined;
}

export function nextCronRuns(expr: string, untilAt: number, fromAt = Date.now(), maxRuns = 100, timezone?: string): number[] {
  if (!expr.trim()) return [];
  try {
    const interval = CronExpressionParser.parse(expr, { currentDate: new Date(fromAt), tz: timezone });
    const runs: number[] = [];
    while (runs.length < maxRuns) {
      const next = interval.next().getTime();
      if (next > untilAt) return runs;
      runs.push(next);
    }
    return runs;
  } catch {
    return [];
  }
}
