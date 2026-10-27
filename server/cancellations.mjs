// Canceled trips, followed through the day: when BCT first and last marked each one canceled,
// whether it went back on the schedule, which bus was on it, BCT's alert text, the start time BCT
// was still predicting, and whether a bus was seen (by GPS) running it anyway. BCT marks trips
// CANCELED while buses still drive them and alerts call them "Delayed", so a cancellation needs
// that context before it means a missed trip.
//
// Shared by the Node server and the Worker's Durable Object. Each service day is one JSON value.
import { addDays, ymdInZone } from '../web/gtfs-util.js';

const MAX_ALERTS = 5;
const MAX_RECENT = 300;

// Alerts feed -> Map of trip id -> [{ header, description, cause, effect }].
export function alertsByTrip(alertFeed) {
  const text = t => t?.translation?.find(x => !x.language || x.language.startsWith('en'))?.text ?? t?.translation?.[0]?.text ?? null;
  const out = new Map();
  for (const { alert } of alertFeed?.entity ?? []) {
    if (!alert) continue;
    const info = { header: text(alert.headerText), description: text(alert.descriptionText), cause: alert.cause ?? null, effect: alert.effect ?? null };
    for (const e of alert.informedEntity ?? []) {
      const tripId = e.trip?.tripId;
      if (!tripId) continue;
      if (!out.has(tripId)) out.set(tripId, []);
      out.get(tripId).push(info);
    }
  }
  return out;
}

export class CancellationLog {
  #days = new Map(); // service date -> Map trip id -> record
  // Every trip's GPS progress so far (trip id -> { stopsPassed, firstPassAt, lastPassAt,
  // lastPassedSeq }), so a trip canceled late gets credit for the stops it already ran. Memory only.
  #progress = new Map();
  dirty = new Set();

  constructor({ timezone }) {
    this.timezone = timezone;
  }

  // liveTrips: summarizeTripUpdates() trips (web/live.js). busOnTrip: trip id -> vehicle id.
  // alerts: alertsByTrip(). passages: stops buses were seen to pass (SegmentLog onPass).
  // Returns how many trips were newly seen canceled.
  observe({ liveTrips, trips, feedTs, busOnTrip = new Map(), alerts = new Map(), passages = [] }) {
    let added = 0;
    const byTrip = new Map(); // trip id -> record, for any day being followed
    for (const day of this.#days.values()) for (const [id, rec] of day) byTrip.set(id, rec);
    for (const p of passages) {
      const prog = this.#progress.get(p.tripId) ?? this.#progress.set(p.tripId, { stopsPassed: 0, firstPassAt: null, lastPassAt: null, lastPassedSeq: null }).get(p.tripId);
      if (prog.lastPassedSeq != null && p.seq <= prog.lastPassedSeq) continue;
      prog.stopsPassed++;
      prog.lastPassedSeq = p.seq;
      prog.firstPassAt ??= Math.round(p.time);
      prog.lastPassAt = Math.round(p.time);
    }
    for (const live of liveTrips) {
      if (!live.startDate) continue;
      let rec = this.#days.get(live.startDate)?.get(live.tripId);
      if (!live.canceled) {
        // Listed again without CANCELED: back on the schedule.
        if (rec && rec.restoredAt == null) {
          rec.restoredAt = feedTs;
          this.dirty.add(live.startDate);
        }
        continue;
      }
      if (!rec) {
        const firstRow = trips[live.tripId]?.s[0];
        rec = {
          tripId: live.tripId,
          routeId: trips[live.tripId]?.r ?? live.routeId ?? null,
          firstSeenAt: feedTs,
          lastSeenAt: feedTs,
          restoredAt: null,
          vehicles: [],
          alerts: [],
          predictedStartAt: firstRow ? live.bySeq.get(firstRow[0]) ?? null : null,
          stopsPassed: 0,
          firstPassAt: null,
          lastPassAt: null,
          lastPassedSeq: null,
        };
        const day = this.#days.get(live.startDate) ?? this.#days.set(live.startDate, new Map()).get(live.startDate);
        day.set(live.tripId, rec);
        byTrip.set(live.tripId, rec);
        added++;
      }
      rec.lastSeenAt = feedTs;
      rec.restoredAt = null; // canceled again
      const bus = busOnTrip.get(live.tripId);
      if (bus && !rec.vehicles.includes(bus)) rec.vehicles.push(bus);
      for (const a of alerts.get(live.tripId) ?? []) {
        if (rec.alerts.length < MAX_ALERTS && !rec.alerts.some(x => x.header === a.header && x.description === a.description)) rec.alerts.push(a);
      }
      this.dirty.add(live.startDate);
    }
    // Buses seen passing stops on canceled trips, before or after the cancellation: the trip ran, at
    // least partly. (After a restart the saved counts stand until progress catches up with them.)
    for (const [date, day] of this.#days) {
      for (const [id, rec] of day) {
        const prog = this.#progress.get(id);
        if (!prog || prog.stopsPassed <= rec.stopsPassed) continue;
        Object.assign(rec, prog);
        this.dirty.add(date);
      }
    }
    return added;
  }

  // Every trip's GPS progress, for a host that may be stopped between batches (see SegmentLog).
  exportProgress() {
    return Object.fromEntries(this.#progress);
  }

  importProgress(progress) {
    if (progress) this.#progress = new Map(Object.entries(progress));
  }

  dates() {
    return [...this.#days.keys()].sort();
  }

  serialize(date) {
    const day = this.#days.get(date);
    return day && JSON.stringify({ v: 1, trips: [...day.values()] });
  }

  load(date, json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (data?.v === 1) this.#days.set(date, new Map(data.trips.map(r => [r.tripId, r])));
  }

  prune(fromDate) {
    const dropped = this.dates().filter(d => d < fromDate);
    for (const d of dropped) this.#days.delete(d);
    // Progress is only needed for trips that could still be canceled: keep about a day's worth.
    for (const [id, prog] of this.#progress) if (prog.lastPassAt != null && prog.lastPassAt < Date.now() / 1000 - 30 * 3600) this.#progress.delete(id);
    return dropped;
  }

  // The last `days` service days: totals, by route, and every record (newest first).
  summary({ days = 7, nowS = Date.now() / 1000 } = {}) {
    const from = addDays(ymdInZone(new Date(nowS * 1000), this.timezone), -(days - 1));
    const rows = [];
    for (const [date, day] of this.#days) if (date >= from) for (const r of day.values()) rows.push({ date, ...r });
    rows.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
    const byRoute = new Map();
    for (const r of rows) byRoute.set(r.routeId, (byRoute.get(r.routeId) ?? 0) + 1);
    return {
      total: rows.length,
      ranAnyway: rows.filter(r => r.stopsPassed > 0).length,
      restored: rows.filter(r => r.restoredAt != null).length,
      byRoute: [...byRoute].map(([routeId, trips]) => ({ routeId, trips })).sort((a, b) => b.trips - a.trips),
      recent: rows.slice(0, MAX_RECENT),
    };
  }
}
