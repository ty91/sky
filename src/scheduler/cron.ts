import { CronExpressionParser } from 'cron-parser';

/**
 * Compute the next run timestamp (epoch ms) for a cron expression, evaluated in
 * the given IANA timezone, strictly after `after`.
 */
export function nextCronRun(cronExpr: string, timezone: string, after: number): number {
  const interval = CronExpressionParser.parse(cronExpr, {
    currentDate: new Date(after),
    tz: timezone,
  });
  return interval.next().toDate().getTime();
}

export function previousCronRun(cronExpr: string, timezone: string, before: number): number {
  const interval = CronExpressionParser.parse(cronExpr, {
    currentDate: new Date(before),
    tz: timezone,
  });
  return interval.prev().toDate().getTime();
}

/** Returns true when `cronExpr` is a valid standard cron expression. */
export function isValidCronExpr(cronExpr: string): boolean {
  try {
    CronExpressionParser.parse(cronExpr);
    return true;
  } catch {
    return false;
  }
}
