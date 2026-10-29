// The dates an analytics summary covers: the last `days` days up to today, or a range the viewer
// picked (from..to, YYYYMMDD, inclusive). Shared by the Node server and the Worker. Recordings are
// kept for 30 days, so a range is held inside the last MAX_DAYS days.
import { addDays, ymdInZone } from '../web/gtfs-util.js';

export const MAX_DAYS = 30;
const YMD = /^\d{8}$/;

// -> { from, to, days (how many dates), dates: [YYYYMMDD oldest first] }
export function dateRange({ days = 7, from = null, to = null, timezone, nowS = Date.now() / 1000 }) {
  const today = ymdInZone(new Date(nowS * 1000), timezone);
  const oldest = addDays(today, -(MAX_DAYS - 1));
  if (!YMD.test(from ?? '') || !YMD.test(to ?? '')) {
    to = today;
    from = addDays(today, -(Math.min(Math.max(days, 1), MAX_DAYS) - 1));
  }
  if (from > to) [from, to] = [to, from];
  if (to > today) to = today;
  if (from < oldest) from = oldest;
  if (from > to) from = to;
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  return { from, to, days: dates.length, dates };
}

// An API request's period: ?from=YYYYMMDD&to=YYYYMMDD, or ?days=N (1 to 30, default 7).
export function rangeParams(searchParams) {
  const n = Number.parseInt(searchParams.get('days') ?? '', 10);
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const custom = YMD.test(from ?? '') && YMD.test(to ?? '');
  return { days: Number.isFinite(n) ? Math.min(Math.max(n, 1), MAX_DAYS) : 7, from: custom ? from : null, to: custom ? to : null };
}
