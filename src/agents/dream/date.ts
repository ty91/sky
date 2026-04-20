// L3 Dream Agent — KST date/range utilities.
//
// All date keys are ISO `YYYY-MM-DD` strings interpreted in Asia/Seoul (KST).
// Korea does not observe DST, so the timezone offset is always `+09:00`.

/** Returns the KST date key (`YYYY-MM-DD`) that the given instant falls in. */
export function dateKeyKst(date: Date): string {
  // `sv-SE` locale formats as `YYYY-MM-DD HH:mm:ss`, so slicing the first 10
  // chars yields the KST calendar date without timezone math quirks.
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 10);
}

/** Returns yesterday's KST date key relative to the given instant. */
export function getYesterdayKey(now: Date = new Date()): string {
  const todayKey = dateKeyKst(now);
  const [year, month, day] = todayKey.split('-').map(Number);
  // Construct noon UTC for yesterday's day-before-today; noon avoids any
  // chance of landing on the KST boundary edge.
  const yesterdayNoonUtc = new Date(Date.UTC(year, month - 1, day - 1, 12));
  return dateKeyKst(yesterdayNoonUtc);
}

/**
 * Returns the UTC [start, end) range corresponding to a full KST calendar day.
 *
 * KST = UTC+9 (no DST), so KST 00:00 on `YYYY-MM-DD` is UTC 15:00 on the previous day.
 */
export function kstDayRangeUtc(dateKey: string): { startUtc: Date; endUtc: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    throw new Error(`Invalid dateKey (expected YYYY-MM-DD): ${dateKey}`);
  }
  const [, yStr, mStr, dStr] = match;
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);

  // KST 00:00 → UTC at (year, month-1, day, 0) minus 9 hours.
  const startUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - 9 * 60 * 60 * 1000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

/**
 * Returns the current KST time as an ISO 8601 string with `+09:00` offset.
 * Used in frontmatter `updated` fields.
 */
export function nowIsoKst(now: Date = new Date()): string {
  const kstParts = now
    .toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' })
    .replace(' ', 'T');
  return `${kstParts}+09:00`;
}

/** Korean short day-of-week label (월/화/수/목/금/토/일) for a KST date key. */
export function koreanDayOfWeek(dateKey: string): string {
  const { startUtc } = kstDayRangeUtc(dateKey);
  // Anchor at noon KST = UTC 03:00 of the same date, safely inside the target KST day.
  const kstNoon = new Date(startUtc.getTime() + 12 * 60 * 60 * 1000);
  const weekdayShort = kstNoon.toLocaleString('en-US', {
    timeZone: 'Asia/Seoul',
    weekday: 'short',
  });
  const enLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const koLabels = ['일', '월', '화', '수', '목', '금', '토'];
  const idx = enLabels.indexOf(weekdayShort);
  return idx >= 0 ? koLabels[idx] : '?';
}
