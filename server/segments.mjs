// Bus running times between stops, measured from GPS: the "buses as traffic probes" analytics,
// shared by the Node server and the Worker's Durable Object.
//
// BCT's trip updates don't help here: they drop most stops a bus has passed, and the times they keep
// are the timetable shifted by the current delay. So each vehicle report is placed along its trip's
// stops instead (the stops joined by straight lines, which is close to the street for stops a few
// hundred metres apart), the moment the bus passes each stop is interpolated between consecutive
// reports, and the time between two stops is that segment's running time. Reports at least once a
// minute (the Durable Object's pace; the Node server sees every 10 s refresh) are plenty.
//
// Totals are kept per calendar day: for each stop pair ("from>to"), per time-of-day period, the number
// of runs and the sums of measured and timetabled seconds; and network-wide per hour, for the weather
// comparison. A day is one JSON value, so the Durable Object stores it in one row.
import { ymdInZone } from '../web/gtfs-util.js';

export const PERIODS = [
  { key: 'night', label: 'Night', from: 0, to: 6 },
  { key: 'am', label: 'Morning peak', from: 6, to: 9 },
  { key: 'midday', label: 'Midday', from: 9, to: 15 },
  { key: 'pm', label: 'Afternoon peak', from: 15, to: 19 },
  { key: 'evening', label: 'Evening', from: 19, to: 24 },
];
const periodOf = hour => PERIODS.findIndex(p => hour >= p.from && hour < p.to);

const MAX_OFF_ROUTE_M = 250; // a report further than this from the trip's stops is ignored
const MAX_GAP_S = 300; // reports further apart than this aren't joined up
const MAX_RUN_S = 30 * 60;
const MAX_SPEED_MPS = 31; // 70 mph: faster means a bad fix
// A bus waits at its first stop, so it counts as gone once it's this far past it.
const ORIGIN_DEPARTED_M = 25;
const M_PER_DEG_LAT = 110_540;

// stops: Map of stop id -> { lat, lon }. Returns the trip's stops as a line in local metres with
// the distance along it to each stop, or null if a stop is unknown.
function tripLine(trip, stops) {
  const coords = trip.s.map(r => stops.get(r[1]));
  if (coords.some(c => !c)) return null;
  const lat0 = coords[0].lat;
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111_320;
  const pts = coords.map(c => [c.lon * kx, c.lat * M_PER_DEG_LAT]);
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { kx, pts, along };
}

// Distance along the line of the point nearest (lat, lon), searching segments from `fromSeg` on
// (buses don't go backwards, and loops pass the same streets twice). -> { along, seg, off, pastEnd }
// or null. pastEnd: the point is beyond the last stop (at the terminal, say), so it can't say when
// the bus got there.
function project(line, lat, lon, fromSeg = 0) {
  const x = lon * line.kx;
  const y = lat * M_PER_DEG_LAT;
  let best = null;
  for (let i = Math.max(0, fromSeg); i < line.pts.length - 1; i++) {
    const [ax, ay] = line.pts[i];
    const [bx, by] = line.pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const raw = len2 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    const t = Math.max(0, Math.min(1, raw));
    const off = Math.hypot(ax + t * dx - x, ay + t * dy - y);
    if (!best || off < best.off) best = { along: line.along[i] + t * Math.sqrt(len2), seg: i, off, pastEnd: i === line.pts.length - 2 && raw > 1 };
  }
  return best && best.off <= MAX_OFF_ROUTE_M ? best : null;
}

const emptyDay = () => ({ seg: new Map(), hours: Array.from({ length: 24 }, () => [0, 0, 0]) });

export class SegmentLog {
  #days = new Map(); // calendar date -> { seg: Map "from>to" -> [n, run, sched] × periods (flat), hours }
  #buses = new Map(); // vehicle id -> { tripId, ts, along, seg, passed: { index, time } }
  #lines = new Map(); // trip id -> tripLine (or null)
  dirty = new Set(); // dates changed since the last save

  constructor({ timezone }) {
    this.timezone = timezone;
    this.hourFormat = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' });
  }

  // vehicleFeed: a decoded vehicle-positions feed. trips: the timetable's trips. stops: Map of stop
  // id -> { lat, lon }. onPass({ tripId, seq, time, startDate }) is called for every stop a bus is
  // seen to pass (the on-time stats use the timepoints). Returns how many stop-to-stop runs were
  // recorded.
  observe(vehicleFeed, { trips, stops, onPass = null }) {
    let recorded = 0;
    const seen = new Set();
    for (const entity of vehicleFeed.entity ?? []) {
      const v = entity.vehicle;
      const tripId = v?.trip?.tripId;
      const trip = tripId && trips[tripId];
      if (!trip || !v.position) continue;
      const id = v.vehicle?.id ?? entity.id;
      const ts = Number(v.timestamp) || Number(vehicleFeed.header.timestamp);
      seen.add(id);
      if (!this.#lines.has(tripId)) this.#lines.set(tripId, tripLine(trip, stops));
      const line = this.#lines.get(tripId);
      if (!line) continue;
      const prev = this.#buses.get(id);
      const sameTrip = prev?.tripId === tripId;
      if (sameTrip && ts <= prev.ts) continue; // the same report again
      const here = project(line, v.position.latitude, v.position.longitude, sameTrip ? prev.seg - 1 : 0);
      if (!here) continue;
      const state = { tripId, ts, along: here.along, seg: here.seg, passed: sameTrip ? prev.passed : null };
      if (sameTrip && ts - prev.ts <= MAX_GAP_S && here.along > prev.along) {
        // Every stop between the two reports, with the time the bus passed it.
        for (let i = 0; i < line.along.length; i++) {
          const at = i === 0 ? Math.min(ORIGIN_DEPARTED_M, line.along[1] / 2) : line.along[i];
          if (at <= prev.along || at > here.along) continue;
          if (here.pastEnd && i === line.along.length - 1) break;
          const time = prev.ts + ((at - prev.along) / (here.along - prev.along)) * (ts - prev.ts);
          if (state.passed?.index === i - 1) recorded += this.#add(trip, i - 1, time - state.passed.time, line.along[i] - line.along[i - 1], state.passed.time);
          state.passed = { index: i, time };
          onPass?.({ tripId, seq: trip.s[i][0], time, startDate: v.trip.startDate || null });
        }
      } else if (!sameTrip || ts - prev.ts > MAX_GAP_S) {
        state.passed = null; // a new trip or a long gap: start again from the next stop
      }
      this.#buses.set(id, state);
    }
    for (const id of this.#buses.keys()) if (!seen.has(id)) this.#buses.delete(id);
    return recorded;
  }

  // One run from stop i to stop i + 1 of `trip`, starting at unix time `startS`.
  #add(trip, i, runS, distanceM, startS) {
    if (runS <= 0 || runS > MAX_RUN_S || distanceM / runS > MAX_SPEED_MPS) return 0;
    const a = trip.s[i];
    const b = trip.s[i + 1];
    const scheduled = a[2] != null && b[2] != null ? b[2] - a[2] : null;
    if (scheduled == null || scheduled < 0) return 0;
    const date = ymdInZone(new Date(startS * 1000), this.timezone);
    const hour = Number(this.hourFormat.format(startS * 1000));
    const day = this.#days.get(date) ?? this.#days.set(date, emptyDay()).get(date);
    const key = `${a[1]}>${b[1]}`;
    let totals = day.seg.get(key);
    if (!totals) day.seg.set(key, (totals = new Array(PERIODS.length * 3).fill(0)));
    const p = periodOf(hour) * 3;
    totals[p] += 1;
    totals[p + 1] += Math.round(runS);
    totals[p + 2] += scheduled;
    const h = day.hours[hour];
    h[0] += 1;
    h[1] += Math.round(runS);
    h[2] += scheduled;
    this.dirty.add(date);
    return 1;
  }

  // ---- Storage: one JSON value per day ---------------------------------------------------------

  // Where each bus was last seen along its trip. A host that may be stopped between reports (the
  // Durable Object) saves this after each batch and restores it, or no bus would ever have a
  // previous report to measure from.
  exportTracking() {
    return Object.fromEntries(this.#buses);
  }

  importTracking(tracking) {
    if (tracking) this.#buses = new Map(Object.entries(tracking));
  }

  dates() {
    return [...this.#days.keys()].sort();
  }

  serialize(date) {
    const day = this.#days.get(date);
    return day && JSON.stringify({ v: 1, seg: Object.fromEntries(day.seg), hours: day.hours });
  }

  load(date, json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (data?.v !== 1) return;
    this.#days.set(date, { seg: new Map(Object.entries(data.seg)), hours: data.hours });
  }

  // Forgets days before `fromDate` (YYYYMMDD). Returns the dates dropped.
  prune(fromDate) {
    const dropped = this.dates().filter(d => d < fromDate);
    for (const d of dropped) this.#days.delete(d);
    this.#lines.clear(); // timetables change; rebuilt as needed
    return dropped;
  }

  // ---- Queries ---------------------------------------------------------------------------------

  // The last `days` calendar days (today included).
  // -> { periods, segments: [[from, to, ...[runs, runSeconds, timetabledSeconds] per period]],
  //      hourRows: [{ date, hour, n, run, sched }] }
  query({ days = 7, nowS = Date.now() / 1000 } = {}) {
    const today = ymdInZone(new Date(nowS * 1000), this.timezone);
    const from = ymdInZone(new Date((nowS - (days - 1) * 86400) * 1000), this.timezone);
    const totals = new Map();
    const hourRows = [];
    for (const [date, day] of this.#days) {
      if (date < from || date > today) continue;
      for (const [key, t] of day.seg) {
        const sum = totals.get(key) ?? totals.set(key, new Array(PERIODS.length * 3).fill(0)).get(key);
        for (let i = 0; i < sum.length; i++) sum[i] += t[i];
      }
      day.hours.forEach(([n, run, sched], hour) => n && hourRows.push({ date, hour, n, run, sched }));
    }
    const segments = [...totals].map(([key, t]) => [...key.split('>'), ...t]);
    return { days, periods: PERIODS.map(({ key, label, from: f, to }) => ({ key, label, from: f, to })), segments, hourRows };
  }
}

// Network running time against the timetable, by weather (the same classes and same-hours
// comparison as weatherImpact in analytics.mjs). index: measured / timetabled time, so 1.1 means
// buses took 10% longer than planned.
export function runningTimeByWeather(hourRows, weather, classes) {
  const byClass = new Map(classes.map(c => [c.wx, { n: 0, run: 0, sched: 0, hours: new Set(), byHour: new Map() }]));
  for (const r of hourRows) {
    const cls = byClass.get(weather.get(`${r.date}|${r.hour}`));
    if (!cls || !r.sched) continue;
    cls.n += r.n;
    cls.run += r.run;
    cls.sched += r.sched;
    cls.hours.add(`${r.date}|${r.hour}`);
    const h = cls.byHour.get(r.hour) ?? cls.byHour.set(r.hour, { n: 0, run: 0, sched: 0 }).get(r.hour);
    h.n += r.n;
    h.run += r.run;
    h.sched += r.sched;
  }
  const dry = byClass.get('dry');
  const index = c => (c.sched ? Math.round((1000 * c.run) / c.sched) / 1000 : null);
  return classes.map(({ wx, label }) => {
    const c = byClass.get(wx);
    let vsDry = null;
    if (wx !== 'dry') {
      let weight = 0;
      let diff = 0;
      for (const [hour, h] of c.byHour) {
        const d = dry.byHour.get(hour);
        if (!d?.sched || d.n < 50 || !h.sched) continue;
        weight += h.n;
        diff += h.n * (h.run / h.sched - d.run / d.sched);
      }
      if (weight) vsDry = { indexPts: Math.round((1000 * diff) / weight) / 10, runs: weight };
    }
    return { wx, label, hours: c.hours.size, runs: c.n, index: index(c), vsDry };
  });
}
