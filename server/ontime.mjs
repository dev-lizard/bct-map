// On-time performance rules, shared by the Node server's log (reliability.mjs) and the Worker's
// Durable Object (worker/recorder.js). Departure-based, the way BCT reports it: at each timepoint
// a bus leaves, how early or late it left against the timetable. 1 minute or more early is early,
// 5 minutes or more late is late, anything in between is on time. Departures more than 10 minutes
// late are also counted, so very late buses don't hide inside "late".
//
// The time is measured from GPS: the moment the bus is seen pulling away from the stop, 25 m past it
// (server/segments.mjs). A trip's last stop has no departure, so it isn't counted. BCT's trip updates
// aren't used: for stops a bus has passed they mostly give the timetable shifted by the current
// delay, not an observed time.
import { addDays, serviceDayStart, ymdInZone } from '../web/gtfs-util.js';

export const ON_TIME_EARLY_S = -60; // this early or more: early
export const ON_TIME_LATE_S = 300; // this late or more: late
export const VERY_LATE_S = 600; // later than this: very late
export const isEarly = delay => delay <= ON_TIME_EARLY_S;
export const isLate = delay => delay >= ON_TIME_LATE_S;
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
    if (!row || row[3] !== 1 || row[2] == null || row === trip.s.at(-1)) continue;
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

// Adds one departure's delay to a running count: { n, early, late, sumDelay, veryLate, sumLate }
// (sumLate: the delays of the late ones, for their average).
export function addDelay(count, delay) {
  count.n++;
  if (isEarly(delay)) count.early++;
  else if (isLate(delay)) {
    count.late++;
    count.sumLate = (count.sumLate ?? 0) + delay;
  }
  if (delay > VERY_LATE_S) count.veryLate = (count.veryLate ?? 0) + 1;
  count.sumDelay += delay;
  return count;
}

export const emptyCount = () => ({ n: 0, early: 0, late: 0, sumDelay: 0, veryLate: 0, sumLate: 0 });
const COUNT_KEYS = ['n', 'early', 'late', 'sumDelay', 'veryLate', 'sumLate'];
export const mergeCount = (into, c) => {
  for (const k of COUNT_KEYS) into[k] += c[k] ?? 0;
  return into;
};
// Fewer departures than this and an hour isn't named as a route's worst.
const MIN_HOUR_SAMPLES = 20;

// counts: [{ routeId, hour, n, early, late, sumDelay }], already limited to the window. Returns
// overall stats plus a row per route, or for one route (routeId set) a row per hour of the day.
export function summarize(counts, { days, routeId = null, collectingSince = null }) {
  const rows = routeId ? counts.filter(c => c.routeId === routeId) : counts;
  const groupBy = (key, list = rows) => {
    const groups = new Map();
    for (const c of list) mergeCount(groups.get(c[key]) ?? groups.set(c[key], emptyCount()).get(c[key]), c);
    return groups;
  };
  const total = rows.reduce(mergeCount, emptyCount());
  const byHour = list => [...groupBy('hour', list)].map(([hour, c]) => ({ hour, ...stats(c) })).sort((a, b) => a.hour - b.hour);
  const result = {
    windowDays: days,
    onTimeWindow: { earlyS: ON_TIME_EARLY_S, lateS: ON_TIME_LATE_S, veryLateS: VERY_LATE_S },
    collectingSince,
    ...stats(total),
  };
  // By hour of the day, for all routes or the one route: riders' experience depends on when they ride.
  result.byHour = byHour(rows);
  if (routeId) {
    result.routeId = routeId;
  } else {
    // Each route with its worst hour (lowest on-time, with enough departures to trust).
    const byRouteRows = new Map();
    for (const c of rows) (byRouteRows.get(c.routeId) ?? byRouteRows.set(c.routeId, []).get(c.routeId)).push(c);
    // route -> hour -> [departures, early, late], for weighting by riders in the browser.
    result.routeHours = {};
    for (const c of rows) {
      const cell = ((result.routeHours[c.routeId] ??= {})[c.hour] ??= [0, 0, 0]);
      cell[0] += c.n;
      cell[1] += c.early;
      cell[2] += c.late;
    }
    result.routes = [...groupBy('routeId')].map(([id, c]) => {
      const worst = byHour(byRouteRows.get(id)).filter(h => h.samples >= MIN_HOUR_SAMPLES).sort((a, b) => a.onTimePct - b.onTimePct)[0];
      return { routeId: id, ...stats(c), worstHour: worst ? { hour: worst.hour, onTimePct: worst.onTimePct } : null };
    }).sort((a, b) => b.onTimePct - a.onTimePct || b.samples - a.samples);
  }
  return result;
}

function stats({ n, early, late, sumDelay, veryLate = 0, sumLate = 0 }) {
  if (!n) return { samples: 0, onTimePct: null, earlyPct: null, latePct: null, veryLatePct: null, meanDelayS: null, meanLateS: null };
  const pct = k => Math.round((1000 * k) / n) / 10;
  return {
    samples: n, onTimePct: pct(n - early - late), earlyPct: pct(early), latePct: pct(late), veryLatePct: pct(veryLate),
    meanDelayS: Math.round(sumDelay / n), meanLateS: late ? Math.round(sumLate / late) : null,
  };
}
