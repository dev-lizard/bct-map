// GPS tracks of the two buses in each bunching event, for replaying it on the map. Every bus's
// recent positions are kept for BEFORE_S; when bunching is found, the two buses' tracks from
// BEFORE_S before the event to AFTER_S after it are saved. A track is a few KB, so a month of them
// is well under a megabyte. Shared by the Node server and the Worker's Durable Object.
import { addDays, ymdInZone } from '../web/gtfs-util.js';

const BEFORE_S = 15 * 60;
const AFTER_S = 15 * 60;
const KEEP_RECENT_S = 20 * 60;
const round5 = v => Math.round(v * 1e5) / 1e5;

export const trackKey = e => `${e.date}|${e.leader}|${e.follower}`;

export class TrackLog {
  #recent = new Map(); // vehicle id -> [[unix time, lat, lon, trip id]], oldest first
  #recording = new Map(); // track key -> track still collecting points
  #days = new Map(); // service date -> Map track key -> finished track
  dirty = new Set();

  // Adds every report in a decoded vehicle-positions feed, feeds the tracks being recorded, and
  // finishes those past their end. Returns how many tracks finished.
  observe(vehicleFeed, nowS = Date.now() / 1000) {
    for (const entity of vehicleFeed?.entity ?? []) {
      const v = entity.vehicle;
      if (!v?.position) continue;
      const id = v.vehicle?.id ?? entity.id;
      const ts = Number(v.timestamp) || Number(vehicleFeed.header.timestamp);
      const points = this.#recent.get(id) ?? this.#recent.set(id, []).get(id);
      if (points.length && points.at(-1)[0] >= ts) continue; // the same report again
      const point = [ts, round5(v.position.latitude), round5(v.position.longitude), v.trip?.tripId ?? null];
      points.push(point);
      for (const track of this.#recording.values()) {
        const bus = track.buses.find(b => b.vehicleId === id);
        if (bus && ts <= track.end) bus.points.push(point.slice(0, 3));
      }
    }
    for (const [id, points] of this.#recent) {
      while (points.length && points[0][0] < nowS - KEEP_RECENT_S) points.shift();
      if (!points.length) this.#recent.delete(id);
    }
    let finished = 0;
    for (const [key, track] of this.#recording) {
      if (nowS < track.end) continue;
      this.#recording.delete(key);
      const day = this.#days.get(track.date) ?? this.#days.set(track.date, new Map()).get(track.date);
      day.set(key, { ...track, complete: true });
      this.dirty.add(track.date);
      finished++;
    }
    return finished;
  }

  // Starts recording a bunching event (server/analytics.mjs) whose buses are known.
  capture(event, { leaderBus, followerBus }) {
    const key = trackKey(event);
    if (!leaderBus || !followerBus || this.#recording.has(key) || this.#days.get(event.date)?.has(key)) return false;
    const start = event.at - BEFORE_S;
    const bus = (vehicleId, tripId, role) => ({
      vehicleId, tripId, role,
      points: (this.#recent.get(vehicleId) ?? []).filter(p => p[0] >= start).map(p => p.slice(0, 3)),
    });
    this.#recording.set(key, {
      key,
      date: event.date,
      routeId: event.routeId,
      direction: event.direction,
      stopId: event.stopId,
      at: event.at,
      actualS: event.actualS,
      scheduledS: event.scheduledS,
      start,
      end: event.at + AFTER_S,
      buses: [bus(leaderBus, event.leader, 'leader'), bus(followerBus, event.follower, 'follower')],
    });
    return true;
  }

  // A track by key: finished, or still recording (complete: false), or null.
  get(key) {
    const date = key.split('|')[0];
    return this.#days.get(date)?.get(key) ?? (this.#recording.has(key) ? { ...this.#recording.get(key), complete: false } : null);
  }

  // 'ready', 'recording' or null, for marking which events can be replayed.
  status(key) {
    if (this.#days.get(key.split('|')[0])?.has(key)) return 'ready';
    return this.#recording.has(key) ? 'recording' : null;
  }

  // ---- Storage ---------------------------------------------------------------------------------

  // What a host that may be stopped between batches (the Durable Object) saves after each batch.
  exportState() {
    return { recent: Object.fromEntries(this.#recent), recording: Object.fromEntries(this.#recording) };
  }

  importState(state) {
    if (!state) return;
    this.#recent = new Map(Object.entries(state.recent ?? {}));
    this.#recording = new Map(Object.entries(state.recording ?? {}));
  }

  dates() {
    return [...this.#days.keys()].sort();
  }

  serialize(date) {
    const day = this.#days.get(date);
    return day && JSON.stringify({ v: 1, tracks: [...day.values()] });
  }

  load(date, json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (data?.v === 1) this.#days.set(date, new Map(data.tracks.map(t => [t.key, t])));
  }

  prune(fromDate) {
    const dropped = this.dates().filter(d => d < fromDate);
    for (const d of dropped) this.#days.delete(d);
    return dropped;
  }
}

// Keeps a sensible window of days: the same as the bunching events they belong to.
export const tracksFrom = (timezone, keepDays, nowS = Date.now() / 1000) => addDays(ymdInZone(new Date(nowS * 1000), timezone), -(keepDays - 1));
