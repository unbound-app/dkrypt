import { CronExpressionParser } from 'cron-parser';

export function nextCronRunAt(expr: string): number | undefined {
  if (!expr.trim()) return undefined;
  try {
    return CronExpressionParser.parse(expr).next().getTime();
  } catch {
    return undefined;
  }
}
