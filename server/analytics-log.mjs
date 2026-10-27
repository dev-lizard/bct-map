// The Node server's log of bunching events (the Worker keeps the same in its Durable Object). One
// JSON object per line in data/analytics/<service date>.jsonl, with type 'bunch'; the last
// KEEP_DAYS days are loaded at startup. (Lines of type 'cancel', from before cancellations moved to
// cancellations.mjs, are skipped.)
import fs from 'node:fs/promises';
import path from 'node:path';
import { serviceDayStart } from '../web/gtfs-util.js';
import { bunchKey, findBunching, newEvents, summarizeBunching } from './analytics.mjs';

const KEEP_DAYS = 30;

export class AnalyticsLog {
  bunching = [];
  #seen = { bunch: new Map() }; // service date -> Set of keys
  #writing = Promise.resolve();

  constructor({ dir = null, timezone }) {
    this.dir = dir;
    this.timezone = timezone;
  }

  async load(nowS = Date.now() / 1000) {
    if (!this.dir) return;
    await fs.mkdir(this.dir, { recursive: true });
    for (const file of (await fs.readdir(this.dir)).filter(f => /^\d{8}\.jsonl$/.test(f)).sort()) {
      if (serviceDayStart(file.slice(0, 8), this.timezone) < nowS - (KEEP_DAYS + 1) * 86400) {
        await fs.rm(path.join(this.dir, file), { force: true });
        continue;
      }
      for (const line of (await fs.readFile(path.join(this.dir, file), 'utf8')).split('\n')) {
        if (!line) continue;
        try {
          const { type, ...event } = JSON.parse(line);
          if (type === 'bunch') this.#remember('bunch', event, bunchKey) && this.bunching.push(event);
        } catch {
          // A line cut short by a crash mid-write.
        }
      }
    }
  }

  // Records new bunching events from one batch of trip-update summaries, and returns them.
  // busOnTrip: busesOnTrips() of the vehicle feed.
  observe(liveTrips, trips, busOnTrip = null) {
    const bunches = newEvents(findBunching([...liveTrips], trips, { timezone: this.timezone, busOnTrip }), bunchKey, date => this.#seenFor('bunch', date));
    this.bunching.push(...bunches);
    const lines = bunches.map(e => ({ type: 'bunch', ...e }));
    if (this.dir && lines.length) {
      const byDate = Map.groupBy(lines, l => l.date);
      this.#writing = this.#writing
        .then(() => Promise.all([...byDate].map(([date, l]) => fs.appendFile(path.join(this.dir, `${date}.jsonl`), `${l.map(x => JSON.stringify(x)).join('\n')}\n`))))
        .catch(err => console.error(`[analytics] could not save: ${err.message}`));
    }
    return bunches;
  }

  flush() {
    return this.#writing;
  }

  summary({ days = 7, nowS = Date.now() / 1000 } = {}) {
    return { bunching: summarizeBunching(this.bunching, { days, timezone: this.timezone, nowS }) };
  }

  #seenFor(type, date) {
    const map = this.#seen[type];
    if (!map.has(date)) map.set(date, new Set());
    return map.get(date);
  }

  #remember(type, event, keyOf) {
    const set = this.#seenFor(type, event.date);
    if (set.has(keyOf(event))) return false;
    set.add(keyOf(event));
    return true;
  }
}
