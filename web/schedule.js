// The timetable the browser, the Node dev server and the Worker all read: every trip's stops and
// times for the next two weeks. The build writes it compactly (public/data/<folder>/schedule.json,
// about 150 KB gzipped against 2 MB for one row per stop call):
//
//   { v: 1, meta, calendar, exceptions,
//     routes: { route_id: { p: [pattern], t: [[trip_id, direction_id, headsign, shape_id, service_id, pattern index, [time deltas]]] } } }
//
// A pattern is a trip's stop list, [[stop_sequence, stop_id, 1 if a timepoint else 0]], shared by
// every trip that makes the same stops. Times are seconds from the service day's start, each stored
// as the difference from the one before (null for a stop with no time).
//
// new Schedule(compact) unpacks only per-trip times up front; a trip's rows (`trip.s`, in the old
// [[stop_sequence, stop_id, seconds, 1 if a timepoint]] form) are built the first time they're read.

export function packSchedule({ meta, calendar = {}, exceptions = [], trips }) {
  const routes = {};
  for (const [tripId, trip] of Object.entries(trips)) {
    const route = (routes[trip.r] ??= { p: [], t: [], keys: new Map() });
    const key = trip.s.map(([seq, stopId, , tp]) => `${seq}\u0000${stopId}\u0000${tp ? 1 : 0}`).join('\u0001');
    let pattern = route.keys.get(key);
    if (pattern === undefined) {
      pattern = route.p.length;
      route.p.push(trip.s.map(([seq, stopId, , tp]) => [seq, stopId, tp ? 1 : 0]));
      route.keys.set(key, pattern);
    }
    let prev = 0;
    const deltas = trip.s.map(([, , secs]) => {
      if (secs == null) return null;
      const d = secs - prev;
      prev = secs;
      return d;
    });
    route.t.push([tripId, trip.d ?? 0, trip.h ?? null, trip.sh ?? null, trip.sv ?? null, pattern, deltas]);
  }
  for (const route of Object.values(routes)) delete route.keys;
  return { v: 1, meta, calendar, exceptions, routes };
}

class Trip {
  #pattern;
  #times;
  #rows = null;

  constructor(routeId, [, d, h, sh, sv], pattern, times) {
    this.r = routeId;
    this.d = d;
    this.h = h;
    this.sh = sh;
    this.sv = sv;
    this.#pattern = pattern;
    this.#times = times;
  }

  // [[stop_sequence, stop_id, seconds or null, 1 if a timepoint]], in stop order.
  get s() {
    this.#rows ??= this.#pattern.map(([seq, stopId, tp], i) => (tp ? [seq, stopId, this.#times[i], 1] : [seq, stopId, this.#times[i]]));
    return this.#rows;
  }

  // Seconds at row i, without building the rows.
  secsAt(i) {
    return this.#times[i];
  }
}

export class Schedule {
  #patterns = []; // [{ rows, trips: [Trip] }]
  #calls = new Map(); // stop id -> calls, built on first ask

  constructor(compact) {
    if (compact.v !== 1) throw new Error(`Unsupported schedule format ${compact.v}`);
    this.meta = compact.meta;
    this.calendar = compact.calendar ?? {};
    this.exceptions = compact.exceptions ?? [];
    this.timezone = compact.meta.timezone;
    this.trips = Object.create(null); // trip id -> Trip
    for (const [routeId, route] of Object.entries(compact.routes)) {
      const patterns = route.p.map(rows => ({ rows, trips: [] }));
      for (const row of route.t) {
        const deltas = row[6];
        const times = new Array(deltas.length);
        let t = 0;
        for (let i = 0; i < deltas.length; i++) times[i] = deltas[i] == null ? null : (t += deltas[i]);
        const pattern = patterns[row[5]];
        const trip = new Trip(routeId, row, pattern.rows, times);
        this.trips[row[0]] = trip;
        pattern.trips.push({ tripId: row[0], trip });
      }
      this.#patterns.push(...patterns);
    }
  }

  // Every timetabled call at a stop, by time of day: [{ tripId, seq, secs, last }], where `last`
  // marks a trip's final stop.
  callsAt(stopId) {
    let calls = this.#calls.get(stopId);
    if (calls) return calls;
    calls = [];
    for (const { rows, trips } of this.#patterns) {
      rows.forEach(([seq, id], i) => {
        if (id !== stopId) return;
        for (const { tripId, trip } of trips) {
          const secs = trip.secsAt(i);
          if (secs != null) calls.push({ tripId, seq, secs, last: i === rows.length - 1 });
        }
      });
    }
    calls.sort((a, b) => a.secs - b.secs);
    this.#calls.set(stopId, calls);
    return calls;
  }

  // The routes calling at each stop: Map stop id -> Set of route ids.
  routesByStop() {
    const out = new Map();
    for (const { rows, trips } of this.#patterns) {
      const routes = new Set(trips.map(({ trip }) => trip.r));
      for (const [, id] of rows) for (const r of routes) (out.get(id) ?? out.set(id, new Set()).get(id)).add(r);
    }
    return out;
  }

  // How many buses call at each stop on a day running `services` (a Set of service ids), not
  // counting trips that end there: Map stop id -> count.
  departuresByStop(services) {
    const out = new Map();
    for (const { rows, trips } of this.#patterns) {
      const n = trips.filter(({ trip }) => services.has(trip.sv)).length;
      if (!n) continue;
      rows.forEach(([, id], i) => {
        if (i < rows.length - 1) out.set(id, (out.get(id) ?? 0) + n);
      });
    }
    return out;
  }

  // The last date any service in the timetable runs (YYYYMMDD), so health can warn before it lapses.
  get end() {
    const ends = Object.values(this.calendar).map(c => c.end);
    for (const [date, , type] of this.exceptions) if (type === 1) ends.push(date);
    return ends.sort().at(-1) ?? null;
  }
}

// Accepts the compact form or, for tests and tools, the plain { meta, calendar, exceptions, trips } one.
export function toSchedule(value) {
  if (value instanceof Schedule) return value;
  return new Schedule(value.v === 1 ? value : packSchedule(value));
}
