// Service analytics, shared by the Node server (analytics-log.mjs) and the Worker's Durable Object
// (worker/recorder.js): bus bunching, cancellations, and schedule adherence by weather.
//
// Bunching: two buses on the same route and direction reaching the same stop within BUNCHED_MAX_S
// of each other, and within BUNCHED_SHARE of the gap the timetable plans between them, for trips
// scheduled at least MIN_SCHEDULED_GAP_S apart. Each pair is one event per service day, recorded
// when first seen. Times come from BCT's trip updates (predicted for stops ahead, actual for stops
// just passed), so no map geometry is needed.
import { addDays, serviceDayStart, ymdInZone } from '../web/gtfs-util.js';
import { addDelay, emptyCount, ON_TIME_EARLY_S, ON_TIME_LATE_S } from './ontime.mjs';

export const BUNCHED_MAX_S = 180;
export const BUNCHED_SHARE = 0.25;
export const MIN_SCHEDULED_GAP_S = 600;
const MAX_RECENT = 300;

// Seconds after the service day's start that `trip` is timetabled at `stopId`, with that row's
// stop_sequence, or null. A trip that visits a stop twice (loops) is matched at its first visit.
function scheduledRow(trip, stopId) {
  const row = trip.s.find(r => r[1] === stopId && r[2] != null);
  return row ? { seq: row[0], secs: row[2] } : null;
}

// liveTrips: summaries from summarizeTripUpdates (web/live.js). trips: the timetable's trips.
// busOnTrip: Map of trip id -> vehicle id from the vehicle feed. When given, only trips with a bus
// on them count (BCT also predicts trips no bus has started), and never two trips of one bus.
// -> [{ date, leader, follower, routeId, direction, stopId, at, actualS, scheduledS }]
export function findBunching(liveTrips, trips, { timezone, busOnTrip = null }) {
  const dayStarts = new Map();
  const dayStart = date => dayStarts.get(date) ?? dayStarts.set(date, serviceDayStart(date, timezone)).get(date);
  const groups = new Map(); // "route|direction" -> live trips
  for (const live of liveTrips) {
    const trip = trips[live.tripId];
    if (!trip || live.canceled || !live.nextStop?.time || !live.startDate) continue;
    if (busOnTrip && !busOnTrip.has(live.tripId)) continue;
    const key = `${trip.r}|${trip.d}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(live);
  }
  const events = [];
  for (const group of groups.values()) {
    for (const follower of group) {
      const { stopId, time: followerAt } = follower.nextStop;
      const fTrip = trips[follower.tripId];
      const fRow = scheduledRow(fTrip, stopId);
      if (!fRow) continue;
      // The bus just ahead: the latest other trip at the same stop no later than this one.
      let leader = null;
      for (const other of group) {
        if (other === follower) continue;
        if (busOnTrip && busOnTrip.get(other.tripId) === busOnTrip.get(follower.tripId)) continue;
        const row = scheduledRow(trips[other.tripId], stopId);
        const at = row && other.bySeq.get(row.seq);
        if (!at || at > followerAt) continue;
        if (!leader || at > leader.at) leader = { live: other, row, at };
      }
      if (!leader) continue;
      const scheduledS = (dayStart(follower.startDate) + fRow.secs) - (dayStart(leader.live.startDate) + leader.row.secs);
      const actualS = followerAt - leader.at;
      if (scheduledS < MIN_SCHEDULED_GAP_S || actualS > BUNCHED_MAX_S || actualS > scheduledS * BUNCHED_SHARE) continue;
      events.push({
        date: follower.startDate,
        leader: leader.live.tripId,
        follower: follower.tripId,
        routeId: fTrip.r,
        direction: fTrip.d,
        stopId,
        at: followerAt,
        actualS,
        scheduledS,
      });
    }
  }
  return events;
}

// Vehicle feed -> Map of trip id -> vehicle id, for findBunching.
export function busesOnTrips(vehicleFeed) {
  const out = new Map();
  for (const e of vehicleFeed?.entity ?? []) {
    const tripId = e.vehicle?.trip?.tripId;
    if (tripId) out.set(tripId, e.vehicle.vehicle?.id ?? e.id);
  }
  return out;
}

// -> [{ date, tripId, routeId, at }] for trips the feed marks canceled.
export function findCancellations(liveTrips, trips, feedTs) {
  return [...liveTrips]
    .filter(live => live.canceled && live.startDate)
    .map(live => ({ date: live.startDate, tripId: live.tripId, routeId: trips[live.tripId]?.r ?? live.routeId ?? null, at: feedTs }));
}

// Keeps only events not seen before. seen(date) returns that service date's Set of keys.
export function newEvents(events, keyOf, seen) {
  return events.filter(e => {
    const set = seen(e.date);
    const key = keyOf(e);
    if (set.has(key)) return false;
    set.add(key);
    return true;
  });
}
export const bunchKey = e => `${e.leader}|${e.follower}`;
export const cancelKey = e => e.tripId;

const inWindow = (date, days, today) => date >= addDays(today, -(days - 1));
const countBy = (rows, key) => {
  const counts = new Map();
  for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
  return counts;
};

// events: every recorded bunching event (any order). -> totals, by route, by hour, and the latest.
export function summarizeBunching(events, { days, timezone, nowS = Date.now() / 1000 }) {
  const today = ymdInZone(new Date(nowS * 1000), timezone);
  const rows = events.filter(e => inWindow(e.date, days, today));
  const hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' });
  return {
    total: rows.length,
    byRoute: [...countBy(rows, e => e.routeId)].map(([routeId, events]) => ({ routeId, events })).sort((a, b) => b.events - a.events),
    byHour: [...countBy(rows, e => Number(hourFormat.format(e.at * 1000)))].map(([hour, events]) => ({ hour, events })).sort((a, b) => a.hour - b.hour),
    recent: rows.sort((a, b) => b.at - a.at).slice(0, MAX_RECENT),
    rule: { maxS: BUNCHED_MAX_S, share: BUNCHED_SHARE, minScheduledS: MIN_SCHEDULED_GAP_S },
  };
}

export function summarizeCancellations(rows, { days, timezone, nowS = Date.now() / 1000 }) {
  const today = ymdInZone(new Date(nowS * 1000), timezone);
  const shown = rows.filter(r => inWindow(r.date, days, today));
  return {
    total: shown.length,
    byRoute: [...countBy(shown, r => r.routeId)].map(([routeId, trips]) => ({ routeId, trips })).sort((a, b) => b.trips - a.trips),
    recent: shown.sort((a, b) => b.at - a.at).slice(0, MAX_RECENT),
  };
}

// ---- Weather -----------------------------------------------------------------------------------

export const WEATHER_CLASSES = [
  { wx: 'dry', label: 'Dry' },
  { wx: 'rain', label: 'Rain' },
  { wx: 'heavy', label: 'Heavy rain or storms' },
];

// An hour's rain (inches, the wettest station's) -> 'dry', 'rain' or 'heavy'. A trace counts as dry.
export function classifyRain(inches) {
  if (inches >= 0.1) return 'heavy'; // 2.5 mm
  if (inches >= 0.01) return 'rain';
  return 'dry';
}

// Station rain (the CSV from loadWeatherHistory in extras.mjs) -> Map "YYYYMMDD|hour" -> weather
// class, by Broward local time. The county's hour is as wet as its wettest station, since showers
// here are often a few miles across. A report "valid" at 14:00 covers 13:00–14:00, so it's hour 13.
// Hours no station reported are left out, rather than counted as dry.
export function weatherByHour(csv) {
  const wettest = new Map();
  for (const line of String(csv).split('\n').slice(1)) {
    const [, , valid, inches] = line.split(',');
    const m = valid?.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):/);
    const amount = Number(inches);
    if (!m || !Number.isFinite(amount)) continue;
    let date = `${m[1]}${m[2]}${m[3]}`;
    let hour = Number(m[4]) - 1;
    if (hour < 0) {
      date = addDays(date, -1);
      hour = 23;
    }
    const key = `${date}|${hour}`;
    wettest.set(key, Math.max(wettest.get(key) ?? 0, amount));
  }
  return new Map([...wettest].map(([key, inches]) => [key, classifyRain(inches)]));
}

// counts: [{ date (calendar, YYYYMMDD), hour, n, early, late, sumDelay }] of timepoint departures.
// Each weather class gets its on-time stats, and the difference from dry weather at the same hours
// of the day (weighted by that class's departures), so a rainy rush hour is compared with a dry one.
export function weatherImpact(counts, weather) {
  const byClass = new Map(WEATHER_CLASSES.map(c => [c.wx, { total: emptyCount(), hours: new Set(), byHour: new Map() }]));
  let unmatched = 0;
  for (const c of counts) {
    const wx = weather.get(`${c.date}|${c.hour}`);
    if (!wx) {
      unmatched += c.n;
      continue;
    }
    const cls = byClass.get(wx);
    merge(cls.total, c);
    cls.hours.add(`${c.date}|${c.hour}`);
    if (!cls.byHour.has(c.hour)) cls.byHour.set(c.hour, emptyCount());
    merge(cls.byHour.get(c.hour), c);
  }
  const dry = byClass.get('dry');
  return {
    onTimeWindow: { earlyS: ON_TIME_EARLY_S, lateS: ON_TIME_LATE_S },
    unmatchedSamples: unmatched,
    classes: WEATHER_CLASSES.map(({ wx, label }) => {
      const cls = byClass.get(wx);
      return { wx, label, hours: cls.hours.size, ...rates(cls.total), vsDry: wx === 'dry' ? null : versusDry(cls.byHour, dry.byHour) };
    }),
  };
}

function merge(into, c) {
  into.n += c.n;
  into.early += c.early;
  into.late += c.late;
  into.sumDelay += c.sumDelay;
}

function rates({ n, early, late, sumDelay }) {
  if (!n) return { samples: 0, onTimePct: null, earlyPct: null, latePct: null, meanDelayS: null };
  const pct = k => Math.round((1000 * k) / n) / 10;
  return { samples: n, onTimePct: pct(n - early - late), earlyPct: pct(early), latePct: pct(late), meanDelayS: Math.round(sumDelay / n) };
}

// Hours of the day with too few dry departures to compare against are skipped.
const MIN_DRY_SAMPLES = 20;
function versusDry(byHour, dryByHour) {
  let weight = 0;
  let onTime = 0;
  let delay = 0;
  for (const [hour, c] of byHour) {
    const d = dryByHour.get(hour);
    if (!d || d.n < MIN_DRY_SAMPLES || !c.n) continue;
    const r = rates(c);
    const dr = rates(d);
    weight += c.n;
    onTime += c.n * (r.onTimePct - dr.onTimePct);
    delay += c.n * (r.meanDelayS - dr.meanDelayS);
  }
  if (!weight) return null;
  return { onTimePts: Math.round((10 * onTime) / weight) / 10, meanDelayS: Math.round(delay / weight), samples: weight };
}

// Reliability samples ([unix time, route, delay, hour]) -> hourly counts by calendar date.
export function hourCountsFromSamples(samples, timezone) {
  const counts = new Map();
  for (const [ts, , delay, hour] of samples) {
    const date = ymdInZone(new Date(ts * 1000), timezone);
    const key = `${date}|${hour}`;
    if (!counts.has(key)) counts.set(key, { date, hour, ...emptyCount() });
    addDelay(counts.get(key), delay);
  }
  return [...counts.values()];
}
