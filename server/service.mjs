// Service analytics measured from what buses did, shared by the Node server and the Worker's Durable
// Object, kept as one JSON value per day:
//
//   - Service delivered: which scheduled trips a bus was seen running (vehicle feed or GPS), the
//     stretch of each trip GPS saw it run, and which minutes the recorder was running, so a trip
//     with no bus counts as missed, and one run only in part as partial, only when the recorder was
//     watching for its whole run. Trips BCT marked canceled are counted apart.
//   - Prediction accuracy: BCT's predicted time at each timepoint, sampled when the bus was 0-2,
//     2-5, 5-10, 10-20 and 20-30 minutes away, against when GPS saw it pass.
//   - Headways: on frequent service (timetabled 20 minutes apart or less), the gap between buses
//     at each timepoint against the timetabled gap, for excess wait time.
//   - Schedule fit: each trip's running time between its first and last timepoint seen, against
//     the timetable, and how late it left its first timepoint.
//   - Delay by timepoint: how late buses are at each timepoint, to show where along a route delay
//     builds up. Also kept per route and day as on-time counts, for trends.
//   - Transfers: at hubs (stations whose stops serve 3+ routes), whether a rider arriving on one
//     route would make the timetabled connection to another, given when both buses really came.
//   - Feed quality: stale and missing GPS reports, buses that vanish mid-trip, and predictions that
//     are just the timetable.
import { addDays, serviceDayStart, servicesOn, ymdInZone } from '../web/gtfs-util.js';
import { ON_TIME_EARLY_S, ON_TIME_LATE_S } from './ontime.mjs';
import { dateRange } from './range.mjs';
import { PERIODS } from './segments.mjs';

export const LEAD_BUCKETS = [
  { key: '0-2', label: '0–2 min', min: 0, max: 120 },
  { key: '2-5', label: '2–5 min', min: 120, max: 300 },
  { key: '5-10', label: '5–10 min', min: 300, max: 600 },
  { key: '10-20', label: '10–20 min', min: 600, max: 1200 },
  { key: '20-30', label: '20–30 min', min: 1200, max: 1800 },
];
// A prediction is "accurate" when the bus came no more than 1 minute before it, or 3 after.
export const PREDICTION_EARLY_S = -60;
export const PREDICTION_LATE_S = 180;
export const FREQUENT_S = 20 * 60;
export const LATE_START_S = 120; // leaving the first timepoint later than this is a late start
// A transfer needs this long between the two buses (walking between bays), and is a timetabled
// connection only if the timetable has the second bus leaving within MAX_CONNECTION_WAIT_S.
export const MIN_TRANSFER_S = 120;
export const MAX_CONNECTION_WAIT_S = 30 * 60;
export const HUB_MIN_ROUTES = 3;
export const STALE_S = 120; // a GPS report older than this when the feed was published is stale
export const GPS_GAP_S = 300; // no report from a bus on a trip for this long is a gap
const DROPOUT_REMAINING_S = 15 * 60; // a bus that vanishes with this much of its trip left dropped out
const MAX_HEADWAY_S = 90 * 60;
const MAX_PLAUSIBLE_DELAY_S = 3 * 3600;
const PENDING_MAX_AGE_S = 3 * 3600;
const HUB_RECENT_S = 60 * 60; // buses at a hub are paired with others seen within this long
const TRIP_DONE_AFTER_S = 10 * 60; // no new stops passed for this long: the trip is over
const RUNTIME_MIN_SHARE = 0.8; // the stops seen must cover this share of the trip's timetabled time
const COVERAGE_MIN = 0.9; // share of a trip's minutes the recorder must have run to judge it
// A trip ran only in part when GPS first saw it this far into its timetable, or last saw it this
// far before its end.
export const PARTIAL_S = 15 * 60;
const RECORDING_GAP_S = 180; // the recorder was off for longer than this: don't call trips dropped
const MAX_LIST = 300;

const periodOf = hour => PERIODS.findIndex(p => hour >= p.from && hour < p.to);
const add = (into, values) => values.forEach((v, i) => { into[i] = (into[i] ?? 0) + v; });
const FEED_KEYS = ['reports', 'stale', 'gaps', 'dropouts', 'predictedTrips', 'timetableOnly'];

function newDay() {
  return {
    seen: new Set(), span: {}, coverage: new Array(1440).fill(0), pred: {}, predHour: {}, headway: {}, headwayStop: {}, runtime: {},
    ontime: {}, delayStop: {}, transfers: {}, feed: Object.fromEntries(FEED_KEYS.map(k => [k, 0])), feedRoute: {},
  };
}

// Hubs: parent stations (stops.json rows with location_type 1) whose stops serve at least
// `minRoutes` routes. stopRows: stops.json. schedule: a Schedule (web/schedule.js).
export function findHubs(stopRows, schedule, minRoutes = HUB_MIN_ROUTES) {
  const names = new Map(stopRows.filter(r => r[5] === 1).map(r => [r[0], r[4]]));
  const children = new Map();
  for (const r of stopRows) {
    if (r[5] !== 0 || !names.has(r[7])) continue;
    (children.get(r[7]) ?? children.set(r[7], []).get(r[7])).push(r[0]);
  }
  const routesAt = schedule.routesByStop();
  const hubs = [];
  for (const [id, stops] of children) {
    const routes = new Set(stops.flatMap(s => [...(routesAt.get(s) ?? [])]));
    if (routes.size >= minRoutes) hubs.push({ id, name: names.get(id), stops });
  }
  return hubs;
}

export class ServiceLog {
  #days = new Map(); // date -> day (seen, runtime and dropouts by service date; the rest by calendar date)
  #pending = new Map(); // "trip|seq" -> { routeId, madeAt, b: { bucket index: predicted time } }
  #lastAtStop = new Map(); // "route|dir|stop" -> [time, trip id, service date]
  #trips = new Map(); // trip id -> { date, routeId, first: [seq, time], last: [seq, time], seenAt }
  #lastReport = new Map(); // vehicle id -> [report time, trip id]
  #atHubs = new Map(); // hub id -> [{ t, r, d, sched, at, date, arrives, departs }], the last hour
  #lastObserveS = null;
  #hubs = [];
  #hubOf = new Map(); // stop id -> hub
  #schedule = null;
  #departures = new Map(); // "hub|date" -> Map "route|dir" -> [[timetabled time, trip id]], sorted
  dirty = new Set();

  constructor({ timezone }) {
    this.timezone = timezone;
    this.hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
  }

  // hubs: findHubs(). schedule: the Schedule they came from, for timetabled connections.
  setHubs(hubs, schedule) {
    this.#hubs = hubs;
    this.#hubOf = new Map(hubs.flatMap(h => h.stops.map(s => [s, h])));
    this.#schedule = schedule;
    this.#departures.clear();
  }

  #day(date) {
    this.dirty.add(date);
    return this.#days.get(date) ?? this.#days.set(date, newDay()).get(date);
  }

  #clock(t) {
    const [h, m] = this.hourFormat.format(t * 1000).split(':').map(Number);
    return { date: ymdInZone(new Date(t * 1000), this.timezone), hour: h, minute: h * 60 + m };
  }

  // The service date a trip ran on, when the feed doesn't say: today's or yesterday's timetable,
  // whichever puts its first stop nearest to `time`.
  #serviceDate(trip, time) {
    const first = trip.s.find(r => r[2] != null)?.[2] ?? 0;
    const today = ymdInZone(new Date(time * 1000), this.timezone);
    const yesterday = addDays(today, -1);
    const off = d => Math.abs(time - (serviceDayStart(d, this.timezone) + first));
    return off(yesterday) < off(today) ? yesterday : today;
  }

  // vehicles: decoded vehicle feed (or null if it failed). liveTrips: summarizeTripUpdates() trips.
  // passages: stops buses were seen to pass (SegmentLog onPass). nowS: this batch's time.
  observe({ vehicles = null, liveTrips = [], passages = [], trips, nowS = Date.now() / 1000 }) {
    // After a gap in recording (or on the first call, with nothing to go by), trips left over from
    // before stopped being watched, not running: don't count them as buses that vanished.
    const recordingGap = this.#lastObserveS == null || nowS - this.#lastObserveS > RECORDING_GAP_S;
    this.#lastObserveS = nowS;
    const today = this.#clock(nowS);

    // The recorder was watching this minute; and how good the GPS reports were.
    if (vehicles) {
      const day = this.#day(today.date);
      day.coverage[today.minute] = 1;
      const feedTs = Number(vehicles.header?.timestamp) || nowS;
      for (const e of vehicles.entity ?? []) {
        const tripId = e.vehicle?.trip?.tripId;
        const trip = tripId && trips[tripId];
        if (!trip) continue;
        const ts = Number(e.vehicle.timestamp) || feedTs;
        const date = e.vehicle.trip.startDate || this.#serviceDate(trip, ts);
        if (!this.#days.get(date)?.seen.has(tripId)) this.#day(date).seen.add(tripId);
        const route = (day.feedRoute[trip.r] ??= [0, 0, 0, 0]); // [gaps, dropouts, predicted trips, timetable only]
        day.feed.reports++;
        if (feedTs - ts > STALE_S) day.feed.stale++;
        const id = e.vehicle.vehicle?.id ?? e.id;
        const prev = this.#lastReport.get(id);
        if (prev?.[1] === tripId && ts - prev[0] > GPS_GAP_S) {
          day.feed.gaps++;
          route[0]++;
        }
        if (!prev || ts > prev[0] || prev[1] !== tripId) this.#lastReport.set(id, [ts, tripId]);
      }
      for (const [id, [ts]] of this.#lastReport) if (nowS - ts > 3600) this.#lastReport.delete(id);
    }

    // Predictions at each timepoint ahead, once per lead-time bucket; and whether BCT's prediction
    // for the next stop is just the timetable.
    for (const live of liveTrips) {
      const trip = trips[live.tripId];
      if (!trip || live.canceled || !live.nextStop) continue;
      const nextRow = trip.s.find(r => r[0] === live.nextStop.seq);
      const nextPredicted = live.bySeq.get(live.nextStop.seq);
      if (nextRow?.[2] != null && nextPredicted && live.startDate) {
        const day = this.#day(today.date);
        const route = (day.feedRoute[trip.r] ??= [0, 0, 0, 0]);
        day.feed.predictedTrips++;
        route[2]++;
        if (Math.abs(nextPredicted - (serviceDayStart(live.startDate, this.timezone) + nextRow[2])) < 1) {
          day.feed.timetableOnly++;
          route[3]++;
        }
      }
      for (const [seq, , , timepoint] of trip.s) {
        if (seq < live.nextStop.seq || timepoint !== 1) continue;
        const predicted = live.bySeq.get(seq);
        const lead = predicted - nowS;
        const b = LEAD_BUCKETS.findIndex(x => lead >= x.min && lead < x.max);
        if (!predicted || b < 0) continue;
        const key = `${live.tripId}|${seq}`;
        const entry = this.#pending.get(key) ?? this.#pending.set(key, { routeId: trip.r, madeAt: nowS, b: {} }).get(key);
        entry.b[b] ??= Math.round(predicted);
      }
    }

    for (const p of passages) {
      const trip = trips[p.tripId];
      if (!trip) continue;
      const time = Math.round(p.time);
      const index = trip.s.findIndex(r => r[0] === p.seq);
      const row = trip.s[index];
      const { date: calendarDate, hour } = this.#clock(time);
      const serviceDate = p.startDate || this.#serviceDate(trip, time);
      const dayStart = serviceDayStart(serviceDate, this.timezone);
      if (!this.#days.get(serviceDate)?.seen.has(p.tripId)) this.#day(serviceDate).seen.add(p.tripId);
      // The stretch of the trip GPS has seen: earliest and latest timetabled seconds passed.
      if (row?.[2] != null) {
        const span = this.#day(serviceDate).span;
        const seen = span[p.tripId];
        if (!seen) span[p.tripId] = [row[2], row[2]];
        else if (row[2] < seen[0]) seen[0] = row[2];
        else if (row[2] > seen[1]) seen[1] = row[2];
      }

      // Prediction outcomes.
      const pending = this.#pending.get(`${p.tripId}|${p.seq}`);
      if (pending) {
        this.#pending.delete(`${p.tripId}|${p.seq}`);
        const day = this.#day(calendarDate);
        for (const [b, predicted] of Object.entries(pending.b)) {
          const err = time - predicted;
          const stats = [1, Math.abs(err), err >= PREDICTION_EARLY_S && err <= PREDICTION_LATE_S ? 1 : 0, err < PREDICTION_EARLY_S ? 1 : 0, err > PREDICTION_LATE_S ? 1 : 0];
          add(((day.pred[trip.r] ??= {})[b] ??= []), stats);
          add(((day.predHour[hour] ??= {})[b] ??= []), stats);
        }
      }
      if (!row || row[2] == null) continue;

      // Transfers, at any stop of a hub.
      const hub = this.#hubOf.get(row[1]);
      if (hub) this.#atHub(hub, { t: p.tripId, r: trip.r, d: trip.d, sched: dayStart + row[2], at: time, date: serviceDate, arrives: index > 0, departs: index < trip.s.length - 1 }, calendarDate);
      if (row[3] !== 1) continue;

      // Delay at this timepoint: on-time counts by route, and by stop for where delay builds up.
      const delay = time - (dayStart + row[2]);
      if (Math.abs(delay) <= MAX_PLAUSIBLE_DELAY_S) {
        const day = this.#day(calendarDate);
        add((day.ontime[trip.r] ??= []), [1, delay < ON_TIME_EARLY_S ? 1 : 0, delay > ON_TIME_LATE_S ? 1 : 0, delay]);
        const firstSecs = trip.s.find(r => r[2] != null)[2];
        add((day.delayStop[`${trip.r}|${trip.d}|${row[1]}`] ??= []), [1, delay, row[2] - firstSecs]);
      }

      // Headways at timepoints.
      const stopKey = `${trip.r}|${trip.d}|${row[1]}`;
      const prev = this.#lastAtStop.get(stopKey);
      this.#lastAtStop.set(stopKey, [time, p.tripId, serviceDate]);
      if (prev && prev[1] !== p.tripId) {
        const prevRow = trips[prev[1]]?.s.find(r => r[1] === row[1] && r[2] != null);
        const actual = time - prev[0];
        const scheduled = prevRow ? (dayStart + row[2]) - (serviceDayStart(prev[2], this.timezone) + prevRow[2]) : 0;
        if (scheduled > 0 && scheduled <= FREQUENT_S && actual > 0 && actual <= MAX_HEADWAY_S) {
          const day = this.#day(calendarDate);
          const values = [1, actual, actual * actual, scheduled, scheduled * scheduled];
          add((day.headway[`${trip.r}|${trip.d}|${periodOf(hour)}`] ??= []), values);
          add((day.headwayStop[stopKey] ??= []), values);
        }
      }

      // Running time: first and latest timepoint seen.
      const state = this.#trips.get(p.tripId);
      if (!state) this.#trips.set(p.tripId, { date: serviceDate, routeId: trip.r, first: [p.seq, time], last: [p.seq, time], seenAt: nowS });
      else if (p.seq > state.last[0]) Object.assign(state, { last: [p.seq, time], seenAt: nowS });
    }

    // Trips with nothing new for a while are over: record their running time and start delay, or
    // that the bus vanished with much of the trip left.
    for (const [tripId, state] of this.#trips) {
      if (nowS - state.seenAt < TRIP_DONE_AFTER_S) continue;
      this.#trips.delete(tripId);
      const rows = trips[tripId]?.s;
      const a = rows?.find(r => r[0] === state.first[0]);
      const b = rows?.find(r => r[0] === state.last[0]);
      const timed = rows?.filter(r => r[2] != null);
      if (!a || !b || !timed?.length) continue;
      if (!recordingGap && timed.at(-1)[2] - b[2] > DROPOUT_REMAINING_S) {
        const day = this.#day(state.date);
        day.feed.dropouts++;
        (day.feedRoute[state.routeId] ??= [0, 0, 0, 0])[1]++;
        continue;
      }
      const scheduled = b[2] - a[2];
      const total = timed.at(-1)[2] - timed[0][2];
      if (scheduled <= 0 || !total || scheduled / total < RUNTIME_MIN_SHARE) continue;
      const firstTimepoint = rows.find(r => r[3] === 1 && r[2] != null);
      const startDelay = firstTimepoint?.[0] === a[0] ? state.first[1] - (serviceDayStart(state.date, this.timezone) + a[2]) : null;
      this.#day(state.date).runtime[tripId] = [state.last[1] - state.first[1], scheduled, state.routeId, startDelay];
    }
    for (const [key, entry] of this.#pending) if (nowS - entry.madeAt > PENDING_MAX_AGE_S) this.#pending.delete(key);
  }

  // A bus at a hub: pair it with the other routes' buses there in the last hour, as the arriving or
  // the departing half of a timetabled connection. Each pair is judged once, when the second comes.
  #atHub(hub, bus, calendarDate) {
    const recent = (this.#atHubs.get(hub.id) ?? []).filter(x => bus.at - x.at < HUB_RECENT_S);
    this.#atHubs.set(hub.id, recent);
    if (recent.some(x => x.t === bus.t)) return; // the same bus at another of the hub's stops
    for (const x of recent) {
      if (x.r === bus.r) continue;
      if (x.arrives && bus.departs) this.#judgeTransfer(hub, x, bus, calendarDate);
      if (bus.arrives && x.departs) this.#judgeTransfer(hub, bus, x, calendarDate);
    }
    recent.push(bus);
  }

  // `from` arrives, `to` departs: if `to` is the timetabled connection to its route and direction,
  // was there time to make it? Missed, the rider waits for the next one: the extra wait is timetabled.
  #judgeTransfer(hub, from, to, calendarDate) {
    const list = this.#departuresAt(hub, from.date)?.get(`${to.r}|${to.d}`);
    const i = list?.findIndex(([t]) => t >= from.sched + MIN_TRANSFER_S) ?? -1;
    if (i < 0 || list[i][1] !== to.t || list[i][0] > from.sched + MAX_CONNECTION_WAIT_S) return;
    const made = to.at >= from.at + MIN_TRANSFER_S;
    const extra = !made && list[i + 1] ? list[i + 1][0] - list[i][0] : 0;
    const day = this.#day(calendarDate);
    add(((day.transfers[hub.id] ??= {})[`${from.r}>${to.r}`] ??= []), [1, made ? 1 : 0, made ? to.at - from.at : 0, extra, !made && extra ? 1 : 0]);
  }

  #departuresAt(hub, date) {
    if (!this.#schedule) return null;
    const key = `${hub.id}|${date}`;
    let index = this.#departures.get(key);
    if (index) return index;
    if (this.#departures.size > 500) this.#departures.clear();
    const running = servicesOn(date, this.#schedule.calendar, this.#schedule.exceptions);
    const start = serviceDayStart(date, this.timezone);
    index = new Map();
    for (const stopId of hub.stops) {
      for (const c of this.#schedule.callsAt(stopId)) {
        const trip = this.#schedule.trips[c.tripId];
        if (c.last || !running.has(trip.sv)) continue;
        const k = `${trip.r}|${trip.d}`;
        (index.get(k) ?? index.set(k, []).get(k)).push([start + c.secs, c.tripId]);
      }
    }
    for (const list of index.values()) list.sort((a, b) => a[0] - b[0]);
    this.#departures.set(key, index);
    return index;
  }

  // ---- Storage ---------------------------------------------------------------------------------

  exportState() {
    return {
      pending: Object.fromEntries(this.#pending), lastAtStop: Object.fromEntries(this.#lastAtStop), trips: Object.fromEntries(this.#trips),
      lastReport: Object.fromEntries(this.#lastReport), atHubs: Object.fromEntries(this.#atHubs), lastObserveS: this.#lastObserveS,
    };
  }

  importState(state) {
    if (!state) return;
    this.#pending = new Map(Object.entries(state.pending ?? {}));
    this.#lastAtStop = new Map(Object.entries(state.lastAtStop ?? {}));
    this.#trips = new Map(Object.entries(state.trips ?? {}));
    this.#lastReport = new Map(Object.entries(state.lastReport ?? {}));
    this.#atHubs = new Map(Object.entries(state.atHubs ?? {}));
    this.#lastObserveS = state.lastObserveS ?? null;
  }

  dates() {
    return [...this.#days.keys()].sort();
  }

  serialize(date) {
    const d = this.#days.get(date);
    return d && JSON.stringify({ v: 1, ...d, seen: [...d.seen], coverage: d.coverage.join('') });
  }

  load(date, json) {
    const d = typeof json === 'string' ? JSON.parse(json) : json;
    if (d?.v !== 1) return;
    // Days saved before a field existed get it empty.
    this.#days.set(date, { ...newDay(), ...d, seen: new Set(d.seen), coverage: [...d.coverage].map(Number) });
  }

  prune(fromDate) {
    const dropped = this.dates().filter(d => d < fromDate);
    for (const d of dropped) this.#days.delete(d);
    return dropped;
  }

  // ---- Summary ---------------------------------------------------------------------------------

  // The last `days` days, or from..to (see range.mjs). schedule: { trips, calendar, exceptions }.
  // canceled: Set of "date|trip id" BCT marked canceled.
  summary({ days = 7, from = null, to = null, schedule, canceled = new Set(), nowS = Date.now() / 1000 }) {
    const range = dateRange({ days, from, to, timezone: this.timezone, nowS });
    const { dates } = range;
    const delivered = this.#delivered(dates, schedule, canceled, nowS);
    return {
      days: range.days,
      from: range.from,
      to: range.to,
      buckets: LEAD_BUCKETS,
      predictionWindow: { earlyS: PREDICTION_EARLY_S, lateS: PREDICTION_LATE_S },
      rules: { partialS: PARTIAL_S, lateStartS: LATE_START_S, minTransferS: MIN_TRANSFER_S, maxConnectionWaitS: MAX_CONNECTION_WAIT_S, staleS: STALE_S, gpsGapS: GPS_GAP_S, dropoutRemainingS: DROPOUT_REMAINING_S },
      delivered,
      predictions: this.#predictions(dates),
      headways: this.#headways(dates),
      runtime: this.#runtime(dates),
      delays: this.#sum(dates, 'delayStop'), // "route|dir|stop" -> [n, Σ delay, Σ timetabled seconds from the trip's start]
      transfers: { hubs: this.#hubs.map(({ id, name, stops }) => ({ id, name, stops })), byHub: this.#transfers(dates) },
      feed: { byDate: dates.map(date => ({ date, ...(this.#days.get(date)?.feed ?? {}) })), byRoute: this.#sum(dates, 'feedRoute') },
      daily: this.#daily(dates, delivered.byDate),
    };
  }

  // Adds up one keyed field (key -> [numbers]) across the dates.
  #sum(dates, field) {
    const out = {};
    for (const date of dates) for (const [k, v] of Object.entries(this.#days.get(date)?.[field] ?? {})) add((out[k] ??= []), v);
    return out;
  }

  // Minutes the recorder ran, as running totals per calendar date, for quick coverage checks.
  #coverageIndex(dates) {
    const index = new Map();
    for (const date of [addDays(dates[0], -1), ...dates, addDays(dates.at(-1), 1)]) {
      const c = this.#days.get(date)?.coverage;
      if (!c) continue;
      const sums = new Uint16Array(1441);
      for (let i = 0; i < 1440; i++) sums[i + 1] = sums[i] + (c[i] ? 1 : 0);
      index.set(date, sums);
    }
    return (fromS, toS) => {
      let watched = 0;
      let total = 0;
      for (let t = Math.floor(fromS / 60) * 60; t < toS; ) {
        const { date, minute } = this.#clock(t);
        const end = Math.min(toS, t + (1440 - minute) * 60);
        const span = Math.max(1, Math.round((end - t) / 60));
        const sums = index.get(date);
        if (sums) watched += sums[Math.min(1440, minute + span)] - sums[minute];
        total += span;
        t = end;
      }
      return total ? watched / total : 0;
    };
  }

  #delivered(dates, { trips, calendar, exceptions }, canceled, nowS) {
    const covered = this.#coverageIndex(dates);
    const byRoute = new Map();
    const byDate = [];
    const byRouteDate = {}; // route -> [counts by date], for one route's day-by-day bars
    const missed = [];
    const partial = [];
    for (const date of dates) {
      const running = servicesOn(date, calendar, exceptions);
      const dayStart = serviceDayStart(date, this.timezone);
      const seen = this.#days.get(date)?.seen ?? new Set();
      const spans = this.#days.get(date)?.span ?? {};
      const counts = { date, scheduled: 0, operated: 0, partial: 0, canceled: 0, missed: 0, unknown: 0 };
      for (const [tripId, trip] of Object.entries(trips)) {
        if (!running.has(trip.sv)) continue;
        const timed = trip.s.filter(r => r[2] != null);
        if (!timed.length) continue;
        const start = dayStart + timed[0][2];
        const end = dayStart + timed.at(-1)[2];
        if (end + 1800 > nowS) continue; // not over yet
        let status;
        let part = null;
        if (seen.has(tripId)) {
          // Seen only in the vehicle feed (no stops passed), or with gaps in recording: counted as run.
          const span = spans[tripId];
          const late = span ? span[0] - timed[0][2] : 0;
          const early = span ? timed.at(-1)[2] - span[1] : 0;
          if ((late >= PARTIAL_S || early >= PARTIAL_S) && covered(start - 600, end + 600) >= COVERAGE_MIN) {
            status = 'partial';
            part = { notRunStartS: late, notRunEndS: early, fromStop: timed.find(r => r[2] === span[0])?.[1] ?? null, toStop: timed.findLast(r => r[2] === span[1])?.[1] ?? null };
          } else status = 'operated';
        } else if (canceled.has(`${date}|${tripId}`)) status = 'canceled';
        else if (covered(start - 600, end + 600) >= COVERAGE_MIN) status = 'missed';
        else status = 'unknown';
        counts.scheduled++;
        counts[status]++;
        const r = byRoute.get(trip.r) ?? byRoute.set(trip.r, { routeId: trip.r, scheduled: 0, operated: 0, partial: 0, canceled: 0, missed: 0, unknown: 0 }).get(trip.r);
        r.scheduled++;
        r[status]++;
        const days = (byRouteDate[trip.r] ??= []);
        if (days.at(-1)?.date !== date) days.push({ date, scheduled: 0, operated: 0, partial: 0, canceled: 0, missed: 0, unknown: 0 });
        days.at(-1).scheduled++;
        days.at(-1)[status]++;
        if (status === 'missed') missed.push({ date, tripId, routeId: trip.r, start });
        if (part) partial.push({ date, tripId, routeId: trip.r, start, ...part });
      }
      byDate.push(counts);
    }
    missed.sort((a, b) => b.start - a.start);
    partial.sort((a, b) => b.start - a.start);
    // operated: ran in full (or as far as anyone can tell). partial: GPS saw only part of it run.
    return { byRoute: [...byRoute.values()], byDate, byRouteDate, missed: missed.slice(0, MAX_LIST), partial: partial.slice(0, MAX_LIST) };
  }

  #predictions(dates) {
    const byRoute = {};
    const byHour = {};
    for (const date of dates) {
      const d = this.#days.get(date);
      if (!d) continue;
      for (const [route, buckets] of Object.entries(d.pred)) for (const [b, v] of Object.entries(buckets)) add(((byRoute[route] ??= {})[b] ??= []), v);
      for (const [hour, buckets] of Object.entries(d.predHour)) for (const [b, v] of Object.entries(buckets)) add(((byHour[hour] ??= {})[b] ??= []), v);
    }
    return { byRoute, byHour }; // [count, sum of |error|, accurate, early, late] per bucket
  }

  #headways(dates) {
    return { byPeriod: this.#sum(dates, 'headway'), byStop: this.#sum(dates, 'headwayStop') }; // [count, Σ actual, Σ actual², Σ timetabled, Σ timetabled²]
  }

  #runtime(dates) {
    const byTrip = {};
    for (const date of dates) {
      const d = this.#days.get(date);
      if (!d) continue;
      for (const [tripId, [actual, scheduled, routeId, startDelay = null]] of Object.entries(d.runtime)) {
        const t = (byTrip[tripId] ??= [routeId, 0, 0, 0, 0, 0, 0, 0]);
        t[1]++;
        t[2] += actual;
        t[3] += scheduled;
        if (actual > scheduled * 1.1) t[4]++;
        if (startDelay != null && Math.abs(startDelay) <= MAX_PLAUSIBLE_DELAY_S) {
          t[5]++;
          t[6] += startDelay;
          if (startDelay > LATE_START_S) t[7]++;
        }
      }
    }
    // trip id -> [route, runs, Σ actual, Σ timetabled, runs over by 10%+, runs with a start time, Σ start delay, late starts]
    return { byTrip };
  }

  #transfers(dates) {
    const byHub = {};
    for (const date of dates) {
      for (const [hub, pairs] of Object.entries(this.#days.get(date)?.transfers ?? {})) {
        for (const [pair, v] of Object.entries(pairs)) add(((byHub[hub] ??= {})[pair] ??= []), v);
      }
    }
    return byHub; // hub id -> "from route>to route" -> [connections, made, Σ wait when made, Σ extra wait when missed, missed with a next bus]
  }

  // One row per date for trends: on time and predictions by route, and network-wide headways,
  // transfers and service delivered.
  #daily(dates, deliveredByDate) {
    return dates.map((date, i) => {
      const d = this.#days.get(date);
      const pred = {};
      for (const [route, buckets] of Object.entries(d?.pred ?? {})) for (const v of Object.values(buckets)) add((pred[route] ??= []), [v[0], v[2], v[3]]);
      const headway = [];
      for (const v of Object.values(d?.headway ?? {})) add(headway, v);
      const transfers = [];
      for (const pairs of Object.values(d?.transfers ?? {})) for (const v of Object.values(pairs)) add(transfers, v.slice(0, 2));
      return { date, ontime: d?.ontime ?? {}, pred, headway, transfers, delivered: deliveredByDate[i] };
    });
  }
}

// Average wait for a random arrival given headways (Σh² / 2Σh), and the excess over the timetable's.
export function excessWait([n, sumA, sumA2, sumS, sumS2]) {
  if (!n || !sumA || !sumS) return null;
  const actual = sumA2 / (2 * sumA);
  const scheduled = sumS2 / (2 * sumS);
  return { n, actualWaitS: Math.round(actual), scheduledWaitS: Math.round(scheduled), excessS: Math.round(actual - scheduled) };
}
