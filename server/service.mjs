// Service analytics measured from what buses did, shared by the Node server and the Worker's Durable
// Object, kept as one JSON value per day:
//
//   - Service delivered: which scheduled trips a bus was seen running (vehicle feed or GPS), and
//     which minutes the recorder was running, so a trip with no bus counts as missed only when the
//     recorder was watching for its whole run. Trips BCT marked canceled are counted apart.
//   - Prediction accuracy: BCT's predicted time at each timepoint, sampled when the bus was 0-2,
//     2-5, 5-10, 10-20 and 20-30 minutes away, against when GPS saw it pass.
//   - Headways: on frequent service (timetabled 20 minutes apart or less), the gap between buses
//     at each timepoint against the timetabled gap, for excess wait time.
//   - Schedule fit: each trip's running time between its first and last timepoint seen, against
//     the timetable.
import { addDays, serviceDayStart, servicesOn, ymdInZone } from '../web/gtfs-util.js';
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
const MAX_HEADWAY_S = 90 * 60;
const PENDING_MAX_AGE_S = 3 * 3600;
const TRIP_DONE_AFTER_S = 10 * 60; // no new stops passed for this long: the trip is over
const RUNTIME_MIN_SHARE = 0.8; // the stops seen must cover this share of the trip's timetabled time
const COVERAGE_MIN = 0.9; // share of a trip's minutes the recorder must have run to judge it
const MAX_LIST = 300;

const periodOf = hour => PERIODS.findIndex(p => hour >= p.from && hour < p.to);
const add = (into, values) => values.forEach((v, i) => { into[i] = (into[i] ?? 0) + v; });

function newDay() {
  return { seen: new Set(), coverage: new Array(1440).fill(0), pred: {}, predHour: {}, headway: {}, headwayStop: {}, runtime: {} };
}

export class ServiceLog {
  #days = new Map(); // date -> day (seen and runtime by service date; the rest by calendar date)
  #pending = new Map(); // "trip|seq" -> { routeId, madeAt, b: { bucket index: predicted time } }
  #lastAtStop = new Map(); // "route|dir|stop" -> [time, trip id, service date]
  #trips = new Map(); // trip id -> { date, routeId, first: [seq, time], last: [seq, time], seenAt }
  dirty = new Set();

  constructor({ timezone }) {
    this.timezone = timezone;
    this.hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });
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
    // The recorder was watching this minute.
    if (vehicles) {
      const { date, minute } = this.#clock(nowS);
      this.#day(date).coverage[minute] = 1;
      for (const e of vehicles.entity ?? []) {
        const tripId = e.vehicle?.trip?.tripId;
        const trip = tripId && trips[tripId];
        if (!trip) continue;
        const date = e.vehicle.trip.startDate || this.#serviceDate(trip, Number(e.vehicle.timestamp) || nowS);
        const day = this.#days.get(date);
        if (!day?.seen.has(tripId)) this.#day(date).seen.add(tripId);
      }
    }

    // Predictions at each timepoint ahead, once per lead-time bucket.
    for (const live of liveTrips) {
      const trip = trips[live.tripId];
      if (!trip || live.canceled || !live.nextStop) continue;
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
      const row = trip.s.find(r => r[0] === p.seq);
      const { date: calendarDate, hour } = this.#clock(time);
      const serviceDate = p.startDate || this.#serviceDate(trip, time);
      if (!this.#days.get(serviceDate)?.seen.has(p.tripId)) this.#day(serviceDate).seen.add(p.tripId);

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
      if (!row || row[3] !== 1 || row[2] == null) continue;

      // Headways at timepoints.
      const stopKey = `${trip.r}|${trip.d}|${row[1]}`;
      const prev = this.#lastAtStop.get(stopKey);
      this.#lastAtStop.set(stopKey, [time, p.tripId, serviceDate]);
      if (prev && prev[1] !== p.tripId) {
        const prevRow = trips[prev[1]]?.s.find(r => r[1] === row[1] && r[2] != null);
        const actual = time - prev[0];
        const scheduled = prevRow ? (serviceDayStart(serviceDate, this.timezone) + row[2]) - (serviceDayStart(prev[2], this.timezone) + prevRow[2]) : 0;
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

    // Trips with nothing new for a while are over: record their running time.
    for (const [tripId, state] of this.#trips) {
      if (nowS - state.seenAt < TRIP_DONE_AFTER_S) continue;
      this.#trips.delete(tripId);
      const rows = trips[tripId]?.s;
      const a = rows?.find(r => r[0] === state.first[0]);
      const b = rows?.find(r => r[0] === state.last[0]);
      const timed = rows?.filter(r => r[2] != null);
      if (!a || !b || !timed?.length) continue;
      const scheduled = b[2] - a[2];
      const total = timed.at(-1)[2] - timed[0][2];
      if (scheduled <= 0 || !total || scheduled / total < RUNTIME_MIN_SHARE) continue;
      this.#day(state.date).runtime[tripId] = [state.last[1] - state.first[1], scheduled, state.routeId];
    }
    for (const [key, entry] of this.#pending) if (nowS - entry.madeAt > PENDING_MAX_AGE_S) this.#pending.delete(key);
  }

  // ---- Storage ---------------------------------------------------------------------------------

  exportState() {
    return { pending: Object.fromEntries(this.#pending), lastAtStop: Object.fromEntries(this.#lastAtStop), trips: Object.fromEntries(this.#trips) };
  }

  importState(state) {
    if (!state) return;
    this.#pending = new Map(Object.entries(state.pending ?? {}));
    this.#lastAtStop = new Map(Object.entries(state.lastAtStop ?? {}));
    this.#trips = new Map(Object.entries(state.trips ?? {}));
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
    this.#days.set(date, { ...d, seen: new Set(d.seen), coverage: [...d.coverage].map(Number) });
  }

  prune(fromDate) {
    const dropped = this.dates().filter(d => d < fromDate);
    for (const d of dropped) this.#days.delete(d);
    return dropped;
  }

  // ---- Summary ---------------------------------------------------------------------------------

  // The last `days` days. schedule: { trips, calendar, exceptions }. canceled: Set of
  // "date|trip id" BCT marked canceled.
  summary({ days = 7, schedule, canceled = new Set(), nowS = Date.now() / 1000 }) {
    const today = ymdInZone(new Date(nowS * 1000), this.timezone);
    const dates = Array.from({ length: days }, (_, i) => addDays(today, -i)).reverse();
    return {
      days,
      buckets: LEAD_BUCKETS,
      predictionWindow: { earlyS: PREDICTION_EARLY_S, lateS: PREDICTION_LATE_S },
      delivered: this.#delivered(dates, schedule, canceled, nowS),
      predictions: this.#predictions(dates),
      headways: this.#headways(dates),
      runtime: this.#runtime(dates),
    };
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
    const missed = [];
    for (const date of dates) {
      const running = servicesOn(date, calendar, exceptions);
      const dayStart = serviceDayStart(date, this.timezone);
      const seen = this.#days.get(date)?.seen ?? new Set();
      const counts = { date, scheduled: 0, operated: 0, canceled: 0, missed: 0, unknown: 0 };
      for (const [tripId, trip] of Object.entries(trips)) {
        if (!running.has(trip.sv)) continue;
        const timed = trip.s.filter(r => r[2] != null);
        if (!timed.length) continue;
        const start = dayStart + timed[0][2];
        const end = dayStart + timed.at(-1)[2];
        if (end + 1800 > nowS) continue; // not over yet
        let status;
        if (seen.has(tripId)) status = 'operated';
        else if (canceled.has(`${date}|${tripId}`)) status = 'canceled';
        else if (covered(start - 600, end + 600) >= COVERAGE_MIN) status = 'missed';
        else status = 'unknown';
        counts.scheduled++;
        counts[status]++;
        const r = byRoute.get(trip.r) ?? byRoute.set(trip.r, { routeId: trip.r, scheduled: 0, operated: 0, canceled: 0, missed: 0, unknown: 0 }).get(trip.r);
        r.scheduled++;
        r[status]++;
        if (status === 'missed') missed.push({ date, tripId, routeId: trip.r, start });
      }
      byDate.push(counts);
    }
    missed.sort((a, b) => b.start - a.start);
    return { byRoute: [...byRoute.values()], byDate, missed: missed.slice(0, MAX_LIST) };
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
    const byPeriod = {};
    const byStop = {};
    for (const date of dates) {
      const d = this.#days.get(date);
      if (!d) continue;
      for (const [k, v] of Object.entries(d.headway)) add((byPeriod[k] ??= []), v);
      for (const [k, v] of Object.entries(d.headwayStop)) add((byStop[k] ??= []), v);
    }
    return { byPeriod, byStop }; // [count, Σ actual, Σ actual², Σ timetabled, Σ timetabled²]
  }

  #runtime(dates) {
    const byTrip = {};
    for (const date of dates) {
      const d = this.#days.get(date);
      if (!d) continue;
      for (const [tripId, [actual, scheduled, routeId]] of Object.entries(d.runtime)) {
        const t = (byTrip[tripId] ??= [routeId, 0, 0, 0, 0]);
        t[1]++;
        t[2] += actual;
        t[3] += scheduled;
        if (actual > scheduled * 1.1) t[4]++;
      }
    }
    return { byTrip }; // trip id -> [route, runs, Σ actual, Σ timetabled, runs over by 10%+]
  }
}

// Average wait for a random arrival given headways (Σh² / 2Σh), and the excess over the timetable's.
export function excessWait([n, sumA, sumA2, sumS, sumS2]) {
  if (!n || !sumA || !sumS) return null;
  const actual = sumA2 / (2 * sumA);
  const scheduled = sumS2 / (2 * sumS);
  return { n, actualWaitS: Math.round(actual), scheduledWaitS: Math.round(scheduled), excessS: Math.round(actual - scheduled) };
}
