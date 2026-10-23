// On-time performance rules, shared by the Node server's log (reliability.mjs) and the Worker's
// Durable Object (worker/recorder.js). Measured the way US transit agencies usually do: at each
// timepoint a bus passes, how early or late it was against the timetable. "On time" is no more than
// 1 minute early and 5 minutes late.
//
// The time is measured from GPS: the moment the bus is seen to pass the stop (server/segments.mjs),
// or for a trip's first stop, to pull away from it. BCT's trip updates aren't used: for stops a bus
// has passed they mostly give the timetable shifted by the current delay, not an observed time.
import { addDays, serviceDayStart, ymdInZone } from '../web/gtfs-util.js';

export const ON_TIME_EARLY_S = -60;
export const ON_TIME_LATE_S = 300;
// A "delay" this large means a mismatched trip or date, not a real departure.
const MAX_PLAUSIBLE_DELAY_S = 3 * 3600;

// Yields { date, tripId, seq, routeId, time, delay, hour } for each timepoint departure not in
// seen(date) yet, and adds it there.
// passages: [{ tripId, seq, time, startDate }] from SegmentLog.observe's onPass.
// trips: the timetable's trips (trip_id -> { r, s: [[stop_sequence, stop_id, seconds, 1 if timepoint]] }).
// seen(date): a Set of "trip_id|stop_sequence" already recorded for that service date.
export function* timepointDepartures(passages, trips, { timezone, seen }) {
  const hourFormat = hourFormatFor(timezone);
  for (const p of passages) {
    const trip = trips[p.tripId];
    const row = trip?.s.find(r => r[0] === p.seq);
    if (!row || row[3] !== 1 || row[2] == null) continue;
    const date = p.startDate || serviceDateFor(p.time, row[2], timezone);
    const recorded = seen(date);
    const key = `${p.tripId}|${p.seq}`;
    if (recorded.has(key)) continue;
    recorded.add(key);
    const time = Math.round(p.time);
    const delay = time - (serviceDayStart(date, timezone) + row[2]);
    if (Math.abs(delay) > MAX_PLAUSIBLE_DELAY_S) continue;
    yield { date, tripId: p.tripId, seq: p.seq, routeId: trip.r, time, delay, hour: Number(hourFormat.format(time * 1000)) };
  }
}

// The service date (today's or, for trips past midnight, yesterday's) whose timetable puts `secs`
// nearest to unix time `time`, when the feed doesn't say.
function serviceDateFor(time, secs, timezone) {
  const today = ymdInZone(new Date(time * 1000), timezone);
  const yesterday = addDays(today, -1);
  const off = date => Math.abs(time - (serviceDayStart(date, timezone) + secs));
  return off(yesterday) < off(today) ? yesterday : today;
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
