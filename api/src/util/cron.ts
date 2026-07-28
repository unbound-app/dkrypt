import { CronExpressionParser } from 'cron-parser';

export function nextCronRunAt(expr: string): number | undefined {
  if (!expr.trim()) return undefined;
  try {
    return CronExpressionParser.parse(expr).next().getTime();
  } catch {
    return undefined;
  }
}

export function nextCronRuns(expr: string, untilAt: number, fromAt = Date.now(), maxRuns = 100): number[] {
  if (!expr.trim()) return [];
  try {
    const interval = CronExpressionParser.parse(expr, { currentDate: new Date(fromAt) });
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
