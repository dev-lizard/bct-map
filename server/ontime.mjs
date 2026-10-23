// On-time performance rules, shared by the Node server's log (reliability.mjs) and the Worker's
// Durable Object (worker/recorder.js). Measured the way US transit agencies usually do: at each
// timepoint a bus passes, how early or late it was against the timetable. "On time" is no more than
// 1 minute early and 5 minutes late. The time used is BCT's own trip-update time for the stop once
// the bus is past it, which BCT keeps listing for passed stops.
import { serviceDayStart } from '../web/gtfs-util.js';

export const ON_TIME_EARLY_S = -60;
export const ON_TIME_LATE_S = 300;
// A "delay" this large means a mismatched trip or date, not a real departure.
const MAX_PLAUSIBLE_DELAY_S = 3 * 3600;

// Yields { date, tripId, seq, routeId, time, delay, hour } for each timepoint a bus has passed that
// isn't in seen(date) yet, and adds it there.
// liveTrips: trip-update summaries (summarizeTripUpdates in web/live.js).
// trips: the timetable's trips (trip_id -> { r, s: [[stop_sequence, stop_id, seconds, 1 if timepoint]] }).
// seen(date): a Set of "trip_id|stop_sequence" already recorded for that service date.
export function* passedTimepoints(liveTrips, trips, feedTs, { timezone, seen }) {
  const hourFormat = hourFormatFor(timezone);
  const dayStarts = new Map();
  for (const live of liveTrips) {
    if (live.canceled || !live.nextStop || !live.startDate) continue;
    const trip = trips[live.tripId];
    if (!trip) continue;
    const recorded = seen(live.startDate);
    if (!dayStarts.has(live.startDate)) dayStarts.set(live.startDate, serviceDayStart(live.startDate, timezone));
    const dayStart = dayStarts.get(live.startDate);
    for (const [seq, , secs, timepoint] of trip.s) {
      if (seq >= live.nextStop.seq) break; // rows are in stop order; the rest are still ahead
      if (timepoint !== 1 || secs == null) continue;
      const key = `${live.tripId}|${seq}`;
      if (recorded.has(key)) continue;
      const time = live.bySeq.get(seq);
      if (!time || time > feedTs) continue;
      recorded.add(key);
      const delay = time - (dayStart + secs);
      if (Math.abs(delay) > MAX_PLAUSIBLE_DELAY_S) continue;
      yield { date: live.startDate, tripId: live.tripId, seq, routeId: trip.r, time, delay, hour: Number(hourFormat.format(time * 1000)) };
    }
  }
}

const hourFormats = new Map();
function hourFormatFor(timezone) {
  if (!hourFormats.has(timezone)) hourFormats.set(timezone, new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }));
  return hourFormats.get(timezone);
}

// Adds one departure's delay to a running { n, early, late, sumDelay } count.
export function addDelay(count, delay) {
  count.n++;
  if (delay < ON_TIME_EARLY_S) count.early++;
  else if (delay > ON_TIME_LATE_S) count.late++;
  count.sumDelay += delay;
  return count;
}

export const emptyCount = () => ({ n: 0, early: 0, late: 0, sumDelay: 0 });

// counts: [{ routeId, hour, n, early, late, sumDelay }], already limited to the window. Returns
// overall stats plus a row per route, or for one route (routeId set) a row per hour of the day.
export function summarize(counts, { days, routeId = null, collectingSince = null }) {
  const rows = routeId ? counts.filter(c => c.routeId === routeId) : counts;
  const groupBy = key => {
    const groups = new Map();
    for (const c of rows) {
      const g = groups.get(c[key]) ?? groups.set(c[key], emptyCount()).get(c[key]);
      g.n += c.n;
      g.early += c.early;
      g.late += c.late;
      g.sumDelay += c.sumDelay;
    }
    return groups;
  };
  const total = rows.reduce((t, c) => ({ n: t.n + c.n, early: t.early + c.early, late: t.late + c.late, sumDelay: t.sumDelay + c.sumDelay }), emptyCount());
  const result = {
    windowDays: days,
    onTimeWindow: { earlyS: ON_TIME_EARLY_S, lateS: ON_TIME_LATE_S },
    collectingSince,
    ...stats(total),
  };
  if (routeId) {
    result.routeId = routeId;
    result.byHour = [...groupBy('hour')].map(([hour, c]) => ({ hour, ...stats(c) })).sort((a, b) => a.hour - b.hour);
  } else {
    result.routes = [...groupBy('routeId')].map(([id, c]) => ({ routeId: id, ...stats(c) }))
      .sort((a, b) => b.onTimePct - a.onTimePct || b.samples - a.samples);
  }
  return result;
}

function stats({ n, early, late, sumDelay }) {
  if (!n) return { samples: 0, onTimePct: null, earlyPct: null, latePct: null, meanDelayS: null };
  const pct = k => Math.round((1000 * k) / n) / 10;
  return { samples: n, onTimePct: pct(n - early - late), earlyPct: pct(early), latePct: pct(late), meanDelayS: Math.round(sumDelay / n) };
}
