// The Node server's log of bunching events and cancellations (the Worker keeps the same in its
// Durable Object). One JSON object per line in data/analytics/<service date>.jsonl, with
// type 'bunch' or 'cancel'; the last KEEP_DAYS days are loaded at startup.
import fs from 'node:fs/promises';
import path from 'node:path';
import { serviceDayStart } from '../web/gtfs-util.js';
import { bunchKey, cancelKey, findBunching, findCancellations, newEvents, summarizeBunching, summarizeCancellations } from './analytics.mjs';

const KEEP_DAYS = 30;

export class AnalyticsLog {
  bunching = [];
  cancellations = [];
  #seen = { bunch: new Map(), cancel: new Map() }; // service date -> Set of keys
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
          if (type === 'cancel') this.#remember('cancel', event, cancelKey) && this.cancellations.push(event);
        } catch {
          // A line cut short by a crash mid-write.
        }
      }
    }
  }

  // Records new bunching events and cancellations from one batch of trip-update summaries.
  // busOnTrip: busesOnTrips() of the vehicle feed.
  observe(liveTrips, trips, feedTs, busOnTrip = null) {
    const list = [...liveTrips];
    const seen = type => date => this.#seenFor(type, date);
    const bunches = newEvents(findBunching(list, trips, { timezone: this.timezone, busOnTrip }), bunchKey, seen('bunch'));
    const cancels = newEvents(findCancellations(list, trips, feedTs), cancelKey, seen('cancel'));
    this.bunching.push(...bunches);
    this.cancellations.push(...cancels);
    const lines = [...bunches.map(e => ({ type: 'bunch', ...e })), ...cancels.map(e => ({ type: 'cancel', ...e }))];
    if (this.dir && lines.length) {
      const byDate = Map.groupBy(lines, l => l.date);
      this.#writing = this.#writing
        .then(() => Promise.all([...byDate].map(([date, l]) => fs.appendFile(path.join(this.dir, `${date}.jsonl`), `${l.map(x => JSON.stringify(x)).join('\n')}\n`))))
        .catch(err => console.error(`[analytics] could not save: ${err.message}`));
    }
    return { bunches: bunches.length, cancels: cancels.length };
  }

  flush() {
    return this.#writing;
  }

  summary({ days = 7, nowS = Date.now() / 1000 } = {}) {
    const opts = { days, timezone: this.timezone, nowS };
    return { bunching: summarizeBunching(this.bunching, opts), cancellations: summarizeCancellations(this.cancellations, opts) };
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
