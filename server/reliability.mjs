// The Node server's on-time log (the Worker keeps the same numbers in a Durable Object; see
// worker/recorder.js). The rules are in ontime.mjs.
//
// Each departure is recorded once and appended to data/reliability/<service date>.jsonl, one JSON
// array per line: [unix time, route_id, trip_id, stop_sequence, delay seconds, hour 0-23]. The last
// KEEP_DAYS days are loaded at startup, so the numbers build up across restarts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { serviceDayStart } from '../web/gtfs-util.js';
import { addDelay, emptyCount, passedTimepoints, summarize } from './ontime.mjs';

export { ON_TIME_EARLY_S, ON_TIME_LATE_S } from './ontime.mjs';
const KEEP_DAYS = 30;

export class ReliabilityLog {
  samples = []; // [unix time, route_id, delay seconds, hour], roughly in time order
  #seen = new Map(); // service date -> Set of "trip_id|stop_sequence" already recorded
  #writing = Promise.resolve();

  constructor({ dir = null, timezone, keepDays = KEEP_DAYS }) {
    this.dir = dir;
    this.timezone = timezone;
    this.keepDays = keepDays;
  }

  // Loads the last keepDays of files and deletes older ones.
  async load(nowS = Date.now() / 1000) {
    if (!this.dir) return;
    await fs.mkdir(this.dir, { recursive: true });
    const cutoff = nowS - this.keepDays * 86400;
    const files = (await fs.readdir(this.dir)).filter(f => /^\d{8}\.jsonl$/.test(f)).sort();
    for (const file of files) {
      const date = file.slice(0, 8);
      if (serviceDayStart(date, this.timezone) + 86400 * 2 < cutoff) {
        await fs.rm(path.join(this.dir, file), { force: true });
        continue;
      }
      const text = await fs.readFile(path.join(this.dir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const [ts, routeId, tripId, seq, delay, hour] = JSON.parse(line);
          this.#seenFor(date).add(`${tripId}|${seq}`);
          if (ts >= cutoff) this.samples.push([ts, routeId, delay, hour]);
        } catch {
          // A line cut short by a crash mid-write: skip it.
        }
      }
    }
    this.samples.sort((a, b) => a[0] - b[0]);
  }

  // liveTrips: trip-update summaries ({ tripId, startDate, canceled, nextStop, bySeq }).
  // trips: the timetable's trips. Records every timepoint the bus has already passed and that
  // hasn't been recorded. Returns how many.
  observe(liveTrips, trips, feedTs) {
    const lines = new Map(); // service date -> lines to append
    let added = 0;
    for (const d of passedTimepoints(liveTrips, trips, feedTs, { timezone: this.timezone, seen: date => this.#seenFor(date) })) {
      this.samples.push([d.time, d.routeId, d.delay, d.hour]);
      if (!lines.has(d.date)) lines.set(d.date, []);
      lines.get(d.date).push(JSON.stringify([d.time, d.routeId, d.tripId, d.seq, d.delay, d.hour]));
      added++;
    }
    if (added) this.#prune(feedTs);
    if (this.dir && lines.size) {
      // Appends are chained so lines from consecutive refreshes never interleave.
      this.#writing = this.#writing
        .then(() => Promise.all([...lines].map(([date, l]) => fs.appendFile(path.join(this.dir, `${date}.jsonl`), `${l.join('\n')}\n`))))
        .catch(err => console.error(`[reliability] could not save: ${err.message}`));
    }
    return added;
  }

  // Resolves once everything recorded so far is on disk.
  flush() {
    return this.#writing;
  }

  // On-time stats over the last `days`: overall and per route, or for one route overall and by hour.
  summary({ days = 7, routeId = null, nowS = Date.now() / 1000 } = {}) {
    const since = nowS - days * 86400;
    const counts = this.samples.filter(s => s[0] >= since).map(([, id, delay, hour]) => ({ routeId: id, hour, ...addDelay(emptyCount(), delay) }));
    return summarize(counts, { days, routeId, collectingSince: this.samples[0]?.[0] ?? null });
  }

  #seenFor(date) {
    if (!this.#seen.has(date)) this.#seen.set(date, new Set());
    return this.#seen.get(date);
  }

  // Drops samples past keepDays, and memory of recorded departures from service days long over.
  #prune(nowS) {
    const cutoff = nowS - this.keepDays * 86400;
    if (this.samples.length && this.samples[0][0] < cutoff) this.samples = this.samples.filter(s => s[0] >= cutoff);
    for (const date of this.#seen.keys()) {
      if (serviceDayStart(date, this.timezone) < nowS - 3 * 86400) this.#seen.delete(date);
    }
  }
}
